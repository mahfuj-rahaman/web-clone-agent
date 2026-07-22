/**
 * ==========================================
 * WEB CLONE AGENT - CORE ENGINE
 * Shared by CLI, MCP, REST API, and GUI
 * ==========================================
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import JSZip from 'jszip';
import { renderPage, fetchViaContext } from './renderer.js';

// ─── Config ──────────────────────────────────────────
const CONFIG = {
    proxyTimeout: parseInt(process.env.PROXY_TIMEOUT || '30000', 10),
    userAgent: process.env.USER_AGENT || 'Mozilla/5.0',
    clonesDir: process.env.CLONES_DIR || './clones',
    defaultIncludeImages: process.env.DEFAULT_INCLUDE_IMAGES === 'true',
    defaultRemoveScripts: process.env.DEFAULT_REMOVE_SCRIPTS === 'true',
    maxImageSizeBytes: parseInt(process.env.MAX_IMAGE_SIZE_BYTES || '0', 10),
    includedImageExtensions: (process.env.INCLUDED_IMAGE_EXTENSIONS || 'png,jpg,jpeg,gif,svg,webp,ico,avif').split(','),
    enableLogging: process.env.ENABLE_LOGGING === 'true',
    // ── Full-browser rendering (Camoufox) for JS-heavy / bulky pages ──
    renderMode: process.env.RENDER_MODE || 'auto', // 'auto' | 'always' | 'never'
    renderTimeoutMs: parseInt(process.env.RENDER_TIMEOUT_MS || '15000', 10),
    camoufoxWsEndpoint: process.env.CAMOUFOX_WS_ENDPOINT || null
};

function log(...args) {
    if (CONFIG.enableLogging) console.log(`[${new Date().toISOString()}]`, ...args);
}

// ─── Broken-image placeholder ────────────────────────
// Saved into a clone whenever at least one source image fails to download
// (404, oversized, etc.), so the clone points at a local stand-in instead of
// the original (broken) live URL.
const BROKEN_IMAGE_PATH = '_broken-image.svg';
const BROKEN_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" fill="#e2e8f0"/>
<path d="M30 30h40v40H30z" fill="none" stroke="#94a3b8" stroke-width="3"/>
<path d="M30 30l40 40M70 30l-40 40" stroke="#94a3b8" stroke-width="3"/>
</svg>`;

// ─── Path Safety ─────────────────────────────────────
// Resolves `relPath` under `baseDir` and throws if it would escape baseDir
// (blocks "../" traversal via cloneId / filePath / --output coming from callers).
function safeJoin(baseDir, relPath) {
    const base = path.resolve(baseDir);
    const target = path.resolve(base, relPath);
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error(`Invalid path: ${relPath}`);
    }
    return target;
}

// ─── HTTP Fetch (Server-side, NO CORS issues) ────────
function fetchUrl(url, options = {}) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: { 'User-Agent': CONFIG.userAgent },
            timeout: CONFIG.proxyTimeout
        }, (res) => {
            // Handle redirects
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                const redirectUrl = new URL(res.headers.location, url).href;
                return fetchUrl(redirectUrl, options).then(resolve).catch(reject);
            }

            // Reject non-2xx responses for raw (image/asset) fetches so a site's
            // custom error page (often served with its own 200/404 body) never
            // gets saved to disk as if it were the real asset.
            if (options.raw && (res.statusCode < 200 || res.statusCode >= 300)) {
                res.resume(); // drain so the socket can be reused
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            if (options.raw) {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            } else {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ─── URL Helpers ─────────────────────────────────────
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fixCssUrls(cssText, cssBaseUrl) {
    return cssText.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, url) => {
        if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('#')) {
            return match;
        }
        try {
            return `url('${new URL(url, cssBaseUrl).href}')`;
        } catch { return match; }
    });
}

// ─── DOM-like HTML Parser (regex-based, no browser needed) ──
// We use string manipulation since we're server-side

/**
 * ★ MAIN CLONE FUNCTION
 * @param {string} targetUrl - URL to clone
 * @param {object} options - { includeImages, removeScripts, saveToDisk, createZip }
 * @param {function} onProgress - Progress callback
 * @returns {object} - { html, images, metadata, cloneId, outputPath }
 */
export async function clonePage(targetUrl, options = {}, onProgress = () => {}) {
    const {
        includeImages = CONFIG.defaultIncludeImages,
        removeScripts = CONFIG.defaultRemoveScripts,
        saveToDisk = true,
        createZip = false,
        outputDir = CONFIG.clonesDir,
        renderMode = CONFIG.renderMode
    } = options;

    // Normalize URL
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
    }

    const parsedUrl = new URL(targetUrl);
    const hostname = parsedUrl.hostname;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const cloneId = `${hostname}_${timestamp}`;
    const outputPath = path.join(outputDir, cloneId);

    const images = new Map(); // localPath -> Buffer
    const metadata = {
        id: cloneId,
        url: targetUrl,
        hostname,
        clonedAt: new Date().toISOString(),
        options: { includeImages, removeScripts, renderMode },
        files: { html: 'index.html', images: [], total: 1 }
    };

    // ── Step 1: Fetch HTML ───────────────────────────
    log(`Cloning: ${targetUrl}`);
    let html;
    let rendered = false;
    let renderContext = null; // kept open through image/CSS downloads below
    let finalUrl = targetUrl; // updated if the page (or a <base> tag) redirects resolution elsewhere
    if (renderMode !== 'never') {
        try {
            onProgress('Rendering with headless browser...', 5);
            const result = await renderPage(targetUrl, {
                wsEndpoint: CONFIG.camoufoxWsEndpoint,
                timeoutMs: CONFIG.renderTimeoutMs
            });
            html = result.html;
            rendered = true;
            renderContext = result.context;
            finalUrl = result.finalUrl;
        } catch (e) {
            log(`Render fallback (using plain HTTP fetch): ${e.message}`);
            if (renderMode === 'always') throw e;
        }
    }
    if (html === undefined) {
        onProgress('Fetching HTML...', 5);
        html = await fetchUrl(targetUrl);
    }
    metadata.rendered = rendered;

    // A <base href> tag overrides the document URL as the base for every
    // relative link/src/url() on the page — resolving against targetUrl
    // instead (as this whole pipeline did previously) silently produces
    // wrong paths (missing/extra subdirectory segments) for any site that
    // sets one, which downloadImages then dutifully 404s trying to fetch.
    const baseMatch = html.match(/<base[^>]*href\s*=\s*["']([^"']+)["']/i);
    const baseUrl = baseMatch ? new URL(baseMatch[1], finalUrl).href : finalUrl;

    try {
        // ── Step 2: Inline CSS ───────────────────────────
        onProgress('Inlining CSS...', 15);
        html = await inlineCSS(html, baseUrl, onProgress, renderContext);

        // ── Step 3: Resolve all relative URLs to absolute ──
        onProgress('Resolving URLs...', 30);
        html = resolveAllUrls(html, baseUrl);

        // ── Step 4: Download images ──────────────────────
        if (includeImages) {
            onProgress('Downloading images...', 40);
            const result = await downloadImages(html, baseUrl, onProgress, renderContext);
            html = result.html;
            for (const [p, buf] of result.images) images.set(p, buf);
            metadata.files.images = Array.from(images.keys());
            metadata.files.total = 1 + images.size;
        }
    } finally {
        if (renderContext) await renderContext.close().catch(() => {});
    }

    // ── Step 5: Remove scripts ───────────────────────
    if (removeScripts) {
        onProgress('Removing scripts...', 75);
        html = removeScriptsFromHtml(html);
    }

    // ── Step 6: Cleanup for offline ──────────────────
    onProgress('Cleaning up...', 85);
    html = cleanupForOffline(html, includeImages);

    // ── Step 7: Extract page title ───────────────────
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    metadata.title = titleMatch ? titleMatch[1].trim() : hostname;

    // ── Step 8: Save to disk ─────────────────────────
    if (saveToDisk) {
        onProgress('Saving to disk...', 90);
        fs.mkdirSync(outputPath, { recursive: true });

        // Save HTML
        fs.writeFileSync(path.join(outputPath, 'index.html'), html, 'utf-8');

        // Save images preserving path structure
        for (const [localPath, buffer] of images) {
            const imgFullPath = path.join(outputPath, localPath);
            fs.mkdirSync(path.dirname(imgFullPath), { recursive: true });
            fs.writeFileSync(imgFullPath, buffer);
        }

        // Save metadata
        fs.writeFileSync(
            path.join(outputPath, 'metadata.json'),
            JSON.stringify(metadata, null, 2),
            'utf-8'
        );

        log(`Saved: ${outputPath} (${images.size} images)`);
    }

    // ── Step 9: Create ZIP (optional) ────────────────
    let zipBuffer = null;
    if (createZip) {
        onProgress('Creating ZIP...', 95);
        const zip = new JSZip();
        const folder = zip.folder(hostname);
        folder.file('index.html', html);
        for (const [p, buf] of images) folder.file(p, buf);
        folder.file('metadata.json', JSON.stringify(metadata, null, 2));
        zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    onProgress('Done!', 100);

    return { html, images, metadata, cloneId, outputPath, zipBuffer };
}

// Fetches a URL preferring the already-open rendered-page browser context
// (same cookies/session/fingerprint that got the page itself past any
// hotlink/bot-detection guard), falling back to a plain Node HTTP request —
// either because there's no render context (renderMode 'never'/fallback), or
// because the in-browser request itself failed for some other reason.
async function fetchAssetBuffer(url, renderContext) {
    if (renderContext) {
        try {
            return await fetchViaContext(renderContext, url, { timeoutMs: CONFIG.proxyTimeout });
        } catch { /* fall through to plain HTTP below */ }
    }
    return fetchUrl(url, { raw: true });
}

// ─── Inline CSS ──────────────────────────────────────
async function inlineCSS(html, baseUrl, onProgress, renderContext) {
    const linkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*>/gi;
    const links = html.match(linkRegex) || [];

    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const hrefMatch = link.match(/href=["']([^"']+)["']/);
        if (!hrefMatch) continue;

        const absoluteUrl = new URL(hrefMatch[1], baseUrl).href;
        try {
            onProgress(`Fetching CSS ${i + 1}/${links.length}...`, 15 + (i / links.length) * 15);
            const cssBuffer = await fetchAssetBuffer(absoluteUrl, renderContext);
            const cssText = cssBuffer.toString('utf-8');
            const fixedCss = fixCssUrls(cssText, absoluteUrl);
            const styleTag = `<style data-source="${absoluteUrl}">${fixedCss}</style>`;
            html = html.replace(link, styleTag);
        } catch (e) {
            log(`CSS failed: ${absoluteUrl} - ${e.message}`);
        }
    }

    // Fix url() in existing <style> blocks
    html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
        return `<style${attrs}>${fixCssUrls(css, baseUrl)}</style>`;
    });

    return html;
}

// ─── Resolve All Relative URLs ───────────────────────
function resolveAllUrls(html, baseUrl) {
    // Resolve src, href, data-src, poster attributes
    html = html.replace(/((?:src|href|data-src|poster)\s*=\s*["'])([^"']+)(["'])/gi, (match, pre, url, post) => {
        if (url.startsWith('data:') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('#') || url.startsWith('javascript:')) {
            return match;
        }
        try {
            return pre + new URL(url, baseUrl).href + post;
        } catch { return match; }
    });

    // Resolve srcset
    html = html.replace(/(srcset\s*=\s*["'])([^"']+)(["'])/gi, (match, pre, srcset, post) => {
        const resolved = srcset.split(',').map(entry => {
            const parts = entry.trim().split(/\s+/);
            if (parts[0] && !parts[0].startsWith('http')) {
                try { parts[0] = new URL(parts[0], baseUrl).href; } catch {}
            }
            return parts.join(' ');
        }).join(', ');
        return pre + resolved + post;
    });

    return html;
}

// ─── Download Images ─────────────────────────────────
async function downloadImages(html, pageUrl, onProgress, renderContext) {
    const images = new Map();
    const validExts = CONFIG.includedImageExtensions;
    const maxSize = CONFIG.maxImageSizeBytes;
    const imageUrls = new Set();

    // Extract all image URLs from HTML
    const extPattern = validExts.map(escapeRegex).join('|');
    const urlPatterns = [
        new RegExp(`src=["']([^"']+\\.(?:${extPattern})(?:\\?[^"']*)?)["']`, 'gi'),
        new RegExp(`data-src=["']([^"']+\\.(?:${extPattern})(?:\\?[^"']*)?)["']`, 'gi'),
        new RegExp(`url\\(\\s*['"]?([^'")]+\\.(?:${extPattern})(?:\\?[^'")]*)?)['"]?\\s*\\)`, 'gi'),
        new RegExp(`href=["']([^"']+\\.(?:${extPattern})(?:\\?[^"']*)?)["']`, 'gi')
    ];

    for (const pattern of urlPatterns) {
        let m;
        while ((m = pattern.exec(html)) !== null) {
            try {
                const abs = new URL(m[1], pageUrl).href;
                const ext = new URL(abs).pathname.split('.').pop().toLowerCase();
                if (validExts.includes(ext)) imageUrls.add(abs);
            } catch {}
        }
    }

    // srcset attributes (already resolved to absolute by resolveAllUrls)
    const srcsetPattern = /srcset\s*=\s*["']([^"']+)["']/gi;
    let sm;
    while ((sm = srcsetPattern.exec(html)) !== null) {
        for (const entry of sm[1].split(',')) {
            const candidate = entry.trim().split(/\s+/)[0];
            if (!candidate) continue;
            try {
                const abs = new URL(candidate, pageUrl).href;
                const ext = new URL(abs).pathname.split('.').pop().toLowerCase();
                if (validExts.includes(ext)) imageUrls.add(abs);
            } catch {}
        }
    }

    const urls = Array.from(imageUrls);
    log(`Found ${urls.length} images to download`);

    let downloaded = 0;
    let failed = 0;

    for (const imageUrl of urls) {
        try {
            const buffer = await fetchAssetBuffer(imageUrl, renderContext);

            if (maxSize > 0 && buffer.length > maxSize) {
                log(`Skipping (too large): ${imageUrl}`);
                failed++;
                html = replaceImageUrlVariants(html, imageUrl, BROKEN_IMAGE_PATH);
                continue;
            }

            // ★ Preserve original URL path (SEO-friendly)
            const localPath = new URL(imageUrl).pathname.replace(/^\//, '');
            images.set(localPath, buffer);
            html = replaceImageUrlVariants(html, imageUrl, localPath);

            downloaded++;
            onProgress(`Image ${downloaded}/${urls.length}: ${localPath}`, 40 + (downloaded / urls.length) * 35);
        } catch (e) {
            log(`Image failed: ${imageUrl} - ${e.message}`);
            failed++;
            // Point at a bundled local placeholder instead of leaving the
            // original (broken) live URL in the clone — keeps preview/offline
            // viewing free of outbound requests to a source that just 404'd.
            html = replaceImageUrlVariants(html, imageUrl, BROKEN_IMAGE_PATH);
        }
    }

    if (failed > 0) {
        images.set(BROKEN_IMAGE_PATH, Buffer.from(BROKEN_IMAGE_SVG, 'utf-8'));
    }

    log(`Images: ${downloaded} downloaded, ${failed} failed`);
    return { html, images };
}

// Replace every occurrence of `imageUrl` (absolute, root-relative, and bare
// pathname variants) in `html` with a reference to `localPath`.
// Every clone is saved flat (index.html at the clone root), so any leading
// "../" the original site used (relative to a deeper page path) must be
// stripped, not preserved — otherwise it points above the clone root once
// served. We match an optional run of "../"/"./" segments right before the
// path and replace the whole thing (dots included) with "./localPath". A
// boundary check (quote, "(", or start-of-string) stops this from clipping
// the tail off an unrelated absolute URL/domain that merely ends with the
// same path segment.
function replaceImageUrlVariants(html, imageUrl, localPath) {
    const pathname = new URL(imageUrl).pathname;
    const bare = pathname.replace(/^\//, '');
    const boundary = `(?:^|(?<=["'(]))`;
    const upDirPrefix = `(?:\\.\\.?/)*`;
    html = html.replace(new RegExp(escapeRegex(imageUrl), 'g'), './' + localPath);
    html = html.replace(new RegExp(`${boundary}${upDirPrefix}${escapeRegex(pathname)}`, 'g'), './' + localPath);
    html = html.replace(new RegExp(`${boundary}${upDirPrefix}${escapeRegex(bare)}`, 'g'), './' + localPath);
    return html;
}

// ─── Remove Scripts ──────────────────────────────────
function removeScriptsFromHtml(html) {
    // Remove <script> blocks
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    // Remove inline event handlers
    html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    html = html.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
    return html;
}

// ─── Cleanup for Offline ─────────────────────────────
function cleanupForOffline(html, includeImages) {
    // Remove <base> tag when images are local
    if (includeImages) {
        html = html.replace(/<base[^>]*>/gi, '');
    }

    // Remove preload/prefetch/preconnect/dns-prefetch
    html = html.replace(/<link[^>]*rel=["'](preload|prefetch|preconnect|dns-prefetch|modulepreload)["'][^>]*>/gi, '');

    // Fix lazy loading
    html = html.replace(/loading=["']lazy["']/gi, 'loading="eager"');

    // Remove <noscript> blocks
    html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

    // Remove meta refresh
    html = html.replace(/<meta[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');

    // Remove unreachable external stylesheets
    html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']https?:\/\/[^"']*["'][^>]*>/gi, '');

    return html;
}

// ─── List All Clones ─────────────────────────────────
export function listClones() {
    const clonesDir = CONFIG.clonesDir;
    if (!fs.existsSync(clonesDir)) return [];

    return fs.readdirSync(clonesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
            const metaPath = path.join(clonesDir, d.name, 'metadata.json');
            let metadata = null;
            if (fs.existsSync(metaPath)) {
                metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            }
            return { id: d.name, path: path.join(clonesDir, d.name), metadata };
        })
        .sort((a, b) => (b.metadata?.clonedAt || '').localeCompare(a.metadata?.clonedAt || ''));
}

// ─── Resolve Clone File Path (for static preview serving) ─────
// Returns an absolute path within the clone dir, or null if it would escape / doesn't exist.
export function resolveCloneFilePath(cloneId, filePath) {
    let fullPath;
    try {
        const cloneDir = safeJoin(CONFIG.clonesDir, cloneId);
        fullPath = safeJoin(cloneDir, filePath);
    } catch {
        return null;
    }
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
    return fullPath;
}

// ─── Read Clone File ─────────────────────────────────
export function readCloneFile(cloneId, filePath) {
    let fullPath;
    try {
        const cloneDir = safeJoin(CONFIG.clonesDir, cloneId);
        fullPath = safeJoin(cloneDir, filePath);
    } catch {
        return null;
    }
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf-8');
}

// ─── Delete Clone ────────────────────────────────────
export function deleteClone(cloneId) {
    let fullPath;
    try {
        fullPath = safeJoin(CONFIG.clonesDir, cloneId);
    } catch {
        return false;
    }
    if (!fs.existsSync(fullPath)) return false;
    fs.rmSync(fullPath, { recursive: true, force: true });
    return true;
}

// ─── Delete Clones Older Than maxAgeDays ─────────────
export function cleanupOldClones(maxAgeDays) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const removed = [];
    for (const clone of listClones()) {
        const clonedAt = clone.metadata?.clonedAt ? Date.parse(clone.metadata.clonedAt) : NaN;
        if (!Number.isNaN(clonedAt) && clonedAt < cutoff) {
            if (deleteClone(clone.id)) removed.push(clone.id);
        }
    }
    return removed;
}

// ─── Get Clone as ZIP ────────────────────────────────
export async function getCloneZip(cloneId) {
    let clonePath;
    try {
        clonePath = safeJoin(CONFIG.clonesDir, cloneId);
    } catch {
        return null;
    }
    if (!fs.existsSync(clonePath)) return null;

    const zip = new JSZip();
    const hostname = cloneId.split('_')[0];
    const folder = zip.folder(hostname);

    function addDir(dirPath, zipFolder) {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                addDir(fullPath, zipFolder.folder(entry.name));
            } else {
                zipFolder.file(entry.name, fs.readFileSync(fullPath));
            }
        }
    }

    addDir(clonePath, folder);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export { CONFIG, log };