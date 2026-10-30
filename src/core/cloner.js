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
import crypto from 'crypto';
import zlib from 'zlib';
import { URL } from 'url';
import JSZip from 'jszip';
import { renderPage, fetchViaContext, fetchDocumentViaBrowser } from './renderer.js';

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
    camoufoxWsEndpoint: process.env.CAMOUFOX_WS_ENDPOINT || null,
    // ── Recursive site crawl (cloneSite) ──
    crawlMaxPages: parseInt(process.env.CRAWL_MAX_PAGES || '50', 10),
    crawlMaxDepth: parseInt(process.env.CRAWL_MAX_DEPTH || '3', 10),
    crawlConcurrency: parseInt(process.env.CRAWL_CONCURRENCY || '2', 10),
    crawlDelayMs: parseInt(process.env.CRAWL_DELAY_MS || '250', 10)
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
            if ((options.raw || options.requireOk) && (res.statusCode < 200 || res.statusCode >= 300)) {
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

    targetUrl = normalizeTargetUrl(targetUrl);
    const hostname = new URL(targetUrl).hostname;
    const cloneId = makeCloneId(hostname);
    const outputPath = path.join(outputDir, cloneId);

    const metadata = {
        id: cloneId,
        url: targetUrl,
        hostname,
        clonedAt: new Date().toISOString(),
        options: { includeImages, removeScripts, renderMode },
        files: { html: 'index.html', images: [], total: 1 }
    };

    log(`Cloning: ${targetUrl}`);
    const page = await processPage(targetUrl, { includeImages, removeScripts, renderMode }, onProgress);
    const { html, images } = page;
    metadata.rendered = page.rendered;
    metadata.title = page.title || hostname;
    if (includeImages) {
        metadata.files.images = Array.from(images.keys());
        metadata.files.total = 1 + images.size;
    }

    // ── Save to disk ─────────────────────────────────
    if (saveToDisk) {
        onProgress('Saving to disk...', 90);
        fs.mkdirSync(outputPath, { recursive: true });

        // Save HTML
        fs.writeFileSync(path.join(outputPath, 'index.html'), html, 'utf-8');

        // Save images preserving path structure
        writeImages(outputPath, images);

        // Save metadata
        fs.writeFileSync(
            path.join(outputPath, 'metadata.json'),
            JSON.stringify(metadata, null, 2),
            'utf-8'
        );

        log(`Saved: ${outputPath} (${images.size} images)`);
    }

    // ── Create ZIP (optional) ────────────────────────
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

function normalizeTargetUrl(targetUrl) {
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return 'https://' + targetUrl;
    }
    return targetUrl;
}

function makeCloneId(hostname) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${hostname}_${timestamp}`;
}

function writeImages(outputPath, images) {
    for (const [localPath, buffer] of images) {
        const imgFullPath = safeJoin(outputPath, localPath);
        fs.mkdirSync(path.dirname(imgFullPath), { recursive: true });
        fs.writeFileSync(imgFullPath, buffer);
    }
}

/**
 * Fetches/renders one page and runs it through the offline-cleanup pipeline.
 * Shared by clonePage (single page) and cloneSite (recursive crawl).
 *
 * `assetPrefix` is the relative path from this page's folder back to the
 * clone root ("./" for a root-level page, "../../" for blog/post/index.html),
 * so image references resolve no matter how deep the page is saved.
 * `cache` (optional) lets a crawl reuse CSS/image downloads across pages.
 */
async function processPage(targetUrl, opts, onProgress = () => {}) {
    const {
        includeImages, removeScripts, renderMode,
        assetPrefix = './', cache = null, siteHost = null, requireOk = false
    } = opts;

    // ── Step 1: Fetch HTML ───────────────────────────
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
        html = await fetchUrl(targetUrl, { requireOk });
    }

    // A <base href> tag overrides the document URL as the base for every
    // relative link/src/url() on the page — resolving against targetUrl
    // instead (as this whole pipeline did previously) silently produces
    // wrong paths (missing/extra subdirectory segments) for any site that
    // sets one, which downloadImages then dutifully 404s trying to fetch.
    const baseMatch = html.match(/<base[^>]*href\s*=\s*["']([^"']+)["']/i);
    const baseUrl = baseMatch ? new URL(baseMatch[1], finalUrl).href : finalUrl;

    let images = new Map();
    let links = [];
    try {
        // ── Step 2: Inline CSS ───────────────────────────
        onProgress('Inlining CSS...', 15);
        html = await inlineCSS(html, baseUrl, onProgress, renderContext, cache);

        // ── Step 3: Resolve all relative URLs to absolute ──
        onProgress('Resolving URLs...', 30);
        html = resolveAllUrls(html, baseUrl);
        links = extractLinks(html, baseUrl);

        // ── Step 4: Download images ──────────────────────
        if (includeImages) {
            onProgress('Downloading images...', 40);
            const result = await downloadImages(html, baseUrl, onProgress, renderContext, {
                assetPrefix, cache, siteHost: siteHost || new URL(finalUrl).hostname
            });
            html = result.html;
            images = result.images;
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

    return { html, images, rendered, finalUrl, links, title: titleMatch ? titleMatch[1].trim() : null };
}

// ─── Site crawl helpers ──────────────────────────────

// Extensions that are (or usually render as) HTML pages. Anything else with an
// extension (pdf, zip, png, css, xml, ...) is not followed as a page.
const PAGE_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'cfm', 'shtml', 'xhtml']);

// Never follow these — admin/auth/cart/feed endpoints and WordPress-style
// action query strings that either mutate state or explode the page count.
const DEFAULT_CRAWL_EXCLUDES = [
    /\/wp-(admin|login|json)\b/i,
    /\/(logout|log-out|signout|sign-out|login|cart|checkout|my-account|account)\b/i,
    /\/feed\/?$/i,
    /\/xmlrpc\.php/i,
    /[?&](replytocom|add-to-cart|share|action|preview|s)=/i
];

function siteKey(hostname) {
    return hostname.toLowerCase().replace(/^www\./, '');
}

function isSameSite(hostname, rootHost, includeSubdomains) {
    const h = siteKey(hostname);
    const root = siteKey(rootHost);
    return h === root || (includeSubdomains && h.endsWith('.' + root));
}

// Maps a page URL to where it's saved inside the clone. Also used as the crawl
// dedupe key, so /about and /about/ (and #fragments) collapse to one page.
function pageLocalPath(pageUrl) {
    const u = new URL(pageUrl);
    let p;
    try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
    const trailingSlash = p.endsWith('/');
    p = p.split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .map(seg => seg.replace(/[<>:"|?*\\\x00-\x1f]/g, '_'))
        .join('/');
    if (p && trailingSlash) p += '/';

    let file;
    if (!p || p.endsWith('/')) file = p + 'index.html';
    else if (/\.x?html?$/i.test(p)) file = p;
    else file = p + '/index.html';

    if (u.search) {
        const hash = crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8);
        file = file.replace(/(\.[^./]+)$/, `_${hash}$1`);
    }
    return file;
}

function extractLinks(html, baseUrl) {
    const links = [];
    const re = /<(?:a|area)\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            const u = new URL(m[1].replace(/&amp;/g, '&'), baseUrl);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
            u.hash = '';
            links.push(u.href);
        } catch {}
    }
    return links;
}

// Fetches a sitemap/robots.txt as text. Plain HTTP first (fast); sites that
// 403 non-browser clients get a real Camoufox tab instead. Handles .xml.gz.
async function fetchCrawlDocument(url, renderMode) {
    let buf;
    try {
        buf = await fetchUrl(url, { raw: true });
    } catch (e) {
        if (renderMode === 'never') throw e;
        log(`Plain fetch of ${url} failed (${e.message}), retrying in browser`);
        buf = await fetchDocumentViaBrowser(url, {
            wsEndpoint: CONFIG.camoufoxWsEndpoint,
            timeoutMs: CONFIG.renderTimeoutMs
        });
    }
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf.toString('utf-8');
}

/**
 * Collects page URLs from sitemaps, following sitemap indexes recursively.
 * With explicit `sitemapUrls` only those are read; otherwise sitemaps are
 * discovered from robots.txt "Sitemap:" lines plus the usual default paths.
 */
async function fetchSitemapUrls(origin, { sitemapUrls = [], limit = Infinity, renderMode, onProgress = () => {} } = {}) {
    const urls = new Set();
    const sources = [];
    let queue = [...sitemapUrls];
    if (!queue.length) {
        try {
            const robots = await fetchCrawlDocument(`${origin}/robots.txt`, renderMode);
            queue.push(...[...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]));
        } catch { /* no robots.txt */ }
        queue.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`);
    }
    const seen = new Set();
    while (queue.length && seen.size < 1000 && urls.size < limit) {
        const sm = queue.shift();
        if (seen.has(sm)) continue;
        seen.add(sm);
        let xml;
        try { xml = await fetchCrawlDocument(sm, renderMode); } catch (e) {
            log(`Sitemap failed: ${sm} - ${e.message}`);
            continue;
        }
        const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)]
            .map(m => m[1].replace(/&amp;/g, '&'));
        if (!locs.length) continue;
        sources.push(sm);
        if (/<sitemapindex/i.test(xml)) queue.push(...locs);
        else for (const l of locs) urls.add(l);
        onProgress(`Reading sitemaps... ${urls.size} URLs from ${sources.length} sitemap(s)`, 1);
    }
    return { urls: [...urls], sources };
}

/**
 * ★ RECURSIVE SITE CLONE
 * Crawls `startUrl` breadth-first, following only links on the same site
 * (www. is ignored; other domains are left as live links), and saves every
 * page as <path>/index.html with internal links rewritten to the local copies.
 * Off-site assets (CDN images, stylesheets) are still downloaded/inlined since
 * the pages need them to render — only third-party *pages* are not followed.
 *
 * @param {string} startUrl
 * @param {object} options - clonePage options plus { maxPages, maxDepth,
 *   concurrency, delayMs, useSitemap, sitemapUrls, includeSubdomains, pathPrefix,
 *   exclude }. maxPages <= 0 means no limit. `sitemapUrls` (string or array)
 *   seeds the crawl with every page they list, overriding sitemap discovery.
 * @param {function} onProgress
 */
export async function cloneSite(startUrl, options = {}, onProgress = () => {}) {
    const {
        includeImages = CONFIG.defaultIncludeImages,
        removeScripts = CONFIG.defaultRemoveScripts,
        createZip = false,
        outputDir = CONFIG.clonesDir,
        renderMode = CONFIG.renderMode,
        maxPages: maxPagesOpt = CONFIG.crawlMaxPages,
        maxDepth = CONFIG.crawlMaxDepth,
        concurrency = CONFIG.crawlConcurrency,
        delayMs = CONFIG.crawlDelayMs,
        useSitemap = true,
        sitemapUrls = [],
        includeSubdomains = false,
        pathPrefix = null,
        exclude = []
    } = options;

    const maxPages = maxPagesOpt > 0 ? maxPagesOpt : Infinity;
    const sitemaps = (Array.isArray(sitemapUrls) ? sitemapUrls : [sitemapUrls]).filter(Boolean).map(normalizeTargetUrl);
    startUrl = normalizeTargetUrl(startUrl);
    const start = new URL(startUrl);
    start.hash = '';
    const hostname = start.hostname;
    const cloneId = makeCloneId(hostname);
    const outputPath = path.join(outputDir, cloneId);
    const excludes = [...DEFAULT_CRAWL_EXCLUDES, ...exclude.map(e => e instanceof RegExp ? e : new RegExp(e, 'i'))];

    const shouldCrawl = (href) => {
        let u;
        try { u = new URL(href); } catch { return false; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        if (!isSameSite(u.hostname, hostname, includeSubdomains)) return false;
        if (pathPrefix && !u.pathname.startsWith(pathPrefix)) return false;
        const last = u.pathname.split('/').pop();
        const ext = last.includes('.') ? last.split('.').pop().toLowerCase() : '';
        if (!PAGE_EXTENSIONS.has(ext)) return false;
        return !excludes.some(re => re.test(u.pathname + u.search));
    };

    const metadata = {
        id: cloneId,
        type: 'site',
        url: start.href,
        hostname,
        clonedAt: new Date().toISOString(),
        options: { includeImages, removeScripts, renderMode, maxPages: maxPagesOpt, maxDepth, includeSubdomains, pathPrefix, sitemapUrls: sitemaps },
        files: { html: pageLocalPath(start.href), images: [], total: 0 },
        pages: [],
        failed: []
    };

    fs.mkdirSync(outputPath, { recursive: true });

    // localPath -> true once enqueued; doubles as the dedupe set.
    const enqueued = new Set();
    const queue = [];
    const enqueue = (href, depth) => {
        if (!shouldCrawl(href)) return;
        const key = pageLocalPath(href);
        if (enqueued.has(key) || enqueued.size >= maxPages * 5) return;
        enqueued.add(key);
        queue.push({ url: href, depth });
    };

    enqueue(start.href, 0);
    if (!enqueued.size) throw new Error(`Start URL is excluded from crawling: ${start.href}`);
    if (useSitemap || sitemaps.length) {
        onProgress('Reading sitemaps...', 1);
        const sm = await fetchSitemapUrls(start.origin, { sitemapUrls: sitemaps, limit: maxPages * 5, renderMode, onProgress });
        // Sitemap pages are seeds in their own right (depth 0), so maxDepth
        // still lets the crawl follow links out of each of them.
        for (const u of sm.urls) enqueue(u, 0);
        metadata.sitemap = { sources: sm.sources, urls: sm.urls.length };
        log(`Sitemaps: ${sm.urls.length} URLs from ${sm.sources.length} sitemap(s)`);
        if (sitemaps.length && !sm.sources.length) {
            log(`Warning: none of the given sitemaps could be read: ${sitemaps.join(', ')}`);
        }
    }

    const cache = { css: new Map(), images: new Map() };
    const savedPages = new Map(); // localPath -> url
    const allImages = new Set();
    let inFlight = 0;

    const crawlOne = async ({ url, depth }) => {
        const localPath = pageLocalPath(url);
        const depthDirs = localPath.split('/').length - 1;
        const assetPrefix = depthDirs ? '../'.repeat(depthDirs) : './';
        try {
            const page = await processPage(url, {
                includeImages, removeScripts, renderMode, assetPrefix, cache,
                siteHost: hostname, requireOk: true
            });

            // Redirected off-site (or onto a page we already have) — don't save it.
            if (!isSameSite(new URL(page.finalUrl).hostname, hostname, includeSubdomains)) return;
            const finalKey = pageLocalPath(page.finalUrl);
            if (finalKey !== localPath && savedPages.has(finalKey)) return;

            const fullPath = safeJoin(outputPath, localPath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, page.html, 'utf-8');
            writeImages(outputPath, page.images);
            for (const p of page.images.keys()) allImages.add(p);

            savedPages.set(localPath, url);
            metadata.pages.push({ url, path: localPath, title: page.title, depth, rendered: page.rendered });
            const total = Math.min(maxPages, enqueued.size);
            onProgress(`Page ${savedPages.size}/${total}: ${url}`, Math.min(95, Math.round((savedPages.size / total) * 90)));

            if (depth < maxDepth) for (const link of page.links) enqueue(link, depth + 1);
        } catch (e) {
            log(`Page failed: ${url} - ${e.message}`);
            metadata.failed.push({ url, error: e.message });
        }
    };

    // Simple worker pool: workers pull from the shared queue until it's empty
    // and nobody is still processing a page that might enqueue more links.
    const worker = async () => {
        while (true) {
            if (savedPages.size + inFlight >= maxPages) return;
            const item = queue.shift();
            if (!item) {
                if (inFlight === 0) return;
                await new Promise(r => setTimeout(r, 100));
                continue;
            }
            inFlight++;
            try { await crawlOne(item); } finally { inFlight--; }
            if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    // ── Rewrite internal links to the saved local copies ──
    onProgress('Rewriting internal links...', 96);
    for (const localPath of savedPages.keys()) {
        const fullPath = safeJoin(outputPath, localPath);
        const html = fs.readFileSync(fullPath, 'utf-8');
        fs.writeFileSync(fullPath, rewriteInternalLinks(html, localPath, savedPages, hostname, includeSubdomains), 'utf-8');
    }

    // A crawl started below the root (e.g. /blog/) has no root index.html — add
    // a tiny redirect so opening the clone folder / preview lands on the start page.
    if (!savedPages.has('index.html') && savedPages.has(metadata.files.html)) {
        fs.writeFileSync(path.join(outputPath, 'index.html'),
            `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=./${metadata.files.html}"><a href="./${metadata.files.html}">${metadata.files.html}</a>`,
            'utf-8');
    }

    metadata.title = metadata.pages.find(p => p.path === metadata.files.html)?.title || hostname;
    metadata.rendered = metadata.pages.some(p => p.rendered);
    metadata.files.images = [...allImages];
    metadata.files.total = savedPages.size + allImages.size;
    fs.writeFileSync(path.join(outputPath, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    log(`Saved site: ${outputPath} (${savedPages.size} pages, ${allImages.size} images, ${metadata.failed.length} failed)`);

    if (savedPages.size === 0) {
        throw new Error(`No pages could be cloned from ${start.href}` +
            (metadata.failed[0] ? ` (${metadata.failed[0].error})` : ''));
    }

    let zipBuffer = null;
    if (createZip) {
        onProgress('Creating ZIP...', 98);
        zipBuffer = await zipDirectory(outputPath, hostname);
    }

    onProgress('Done!', 100);
    return { metadata, cloneId, outputPath, zipBuffer };
}

function rewriteInternalLinks(html, fromPath, savedPages, hostname, includeSubdomains) {
    const fromDir = path.posix.dirname(fromPath);
    return html.replace(/(<(?:a|area)\b[^>]*?\shref\s*=\s*["'])([^"']+)(["'])/gi, (match, pre, href, post) => {
        let u;
        try { u = new URL(href.replace(/&amp;/g, '&')); } catch { return match; }
        if (!isSameSite(u.hostname, hostname, includeSubdomains)) return match;
        const hash = u.hash;
        u.hash = '';
        const target = pageLocalPath(u.href);
        if (!savedPages.has(target)) return match;
        let rel = path.posix.relative(fromDir, target) || path.posix.basename(target);
        if (!rel.startsWith('.')) rel = './' + rel;
        return pre + rel + hash + post;
    });
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
async function inlineCSS(html, baseUrl, onProgress, renderContext, cache = null) {
    const linkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*>/gi;
    const links = html.match(linkRegex) || [];

    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const hrefMatch = link.match(/href=["']([^"']+)["']/);
        if (!hrefMatch) continue;

        const absoluteUrl = new URL(hrefMatch[1], baseUrl).href;
        try {
            onProgress(`Fetching CSS ${i + 1}/${links.length}...`, 15 + (i / links.length) * 15);
            // A crawl shares one stylesheet across many pages — fetch it once.
            let cssPromise = cache?.css.get(absoluteUrl);
            if (!cssPromise) {
                cssPromise = fetchAssetBuffer(absoluteUrl, renderContext)
                    .then(buf => fixCssUrls(buf.toString('utf-8'), absoluteUrl));
                if (cache) {
                    cache.css.set(absoluteUrl, cssPromise);
                    cssPromise.catch(() => cache.css.delete(absoluteUrl));
                }
            }
            const fixedCss = await cssPromise;
            const styleTag = `<style data-source="${absoluteUrl}">${fixedCss}</style>`;
            html = html.replace(link, () => styleTag);
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
async function downloadImages(html, pageUrl, onProgress, renderContext, { assetPrefix = './', cache = null, siteHost } = {}) {
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
        const sameSite = siteKey(new URL(imageUrl).hostname) === siteKey(siteHost || new URL(pageUrl).hostname);
        // A crawl reuses each image across pages: only the first page to hit
        // it downloads (and returns) the bytes; later pages just point at it.
        let entry = cache?.images.get(imageUrl);
        const firstUse = !entry;
        if (!entry) {
            entry = fetchImage(imageUrl, renderContext, maxSize, sameSite);
            if (cache) cache.images.set(imageUrl, entry);
        }
        const res = await entry;

        if (res.ok) {
            if (firstUse) images.set(res.localPath, res.buffer);
            html = replaceImageUrlVariants(html, imageUrl, assetPrefix + res.localPath, sameSite);
            downloaded++;
            onProgress(`Image ${downloaded}/${urls.length}: ${res.localPath}`, 40 + (downloaded / urls.length) * 35);
        } else {
            log(`Image failed: ${imageUrl} - ${res.error}`);
            failed++;
            // Point at a bundled local placeholder instead of leaving the
            // original (broken) live URL in the clone — keeps preview/offline
            // viewing free of outbound requests to a source that just 404'd.
            html = replaceImageUrlVariants(html, imageUrl, assetPrefix + BROKEN_IMAGE_PATH, sameSite);
        }
    }

    if (failed > 0) {
        images.set(BROKEN_IMAGE_PATH, Buffer.from(BROKEN_IMAGE_SVG, 'utf-8'));
    }

    log(`Images: ${downloaded} downloaded, ${failed} failed`);
    return { html, images };
}

async function fetchImage(imageUrl, renderContext, maxSize, sameSite) {
    try {
        const buffer = await fetchAssetBuffer(imageUrl, renderContext);
        if (maxSize > 0 && buffer.length > maxSize) return { ok: false, error: 'too large' };
        // ★ Preserve original URL path (SEO-friendly). Off-site images (CDNs)
        // go under _external/<host>/ so two hosts' /logo.png can't collide.
        const u = new URL(imageUrl);
        const pathname = u.pathname.split('/').filter(seg => seg && seg !== '.' && seg !== '..').join('/');
        const localPath = sameSite ? pathname : `_external/${u.hostname}/${pathname}`;
        return { ok: true, buffer, localPath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Replace every occurrence of `imageUrl` (absolute, root-relative, and bare
// pathname variants) in `html` with `localRef` (a path relative to the page).
// Every clone is saved flat (index.html at the clone root), so any leading
// "../" the original site used (relative to a deeper page path) must be
// stripped, not preserved — otherwise it points above the clone root once
// served. We match an optional run of "../"/"./" segments right before the
// path and replace the whole thing (dots included) with "./localPath". A
// boundary check (quote, "(", or start-of-string) stops this from clipping
// the tail off an unrelated absolute URL/domain that merely ends with the
// same path segment.
// Path-only variants are skipped for off-site images: a bare "/logo.png" on
// the page refers to the site's own host, not the CDN's.
function replaceImageUrlVariants(html, imageUrl, localRef, matchPathVariants = true) {
    html = html.replace(new RegExp(escapeRegex(imageUrl), 'g'), () => localRef);
    if (!matchPathVariants) return html;
    const pathname = new URL(imageUrl).pathname;
    const bare = pathname.replace(/^\//, '');
    const boundary = `(?:^|(?<=["'(]))`;
    const upDirPrefix = `(?:\\.\\.?/)*`;
    html = html.replace(new RegExp(`${boundary}${upDirPrefix}${escapeRegex(pathname)}`, 'g'), () => localRef);
    html = html.replace(new RegExp(`${boundary}${upDirPrefix}${escapeRegex(bare)}`, 'g'), () => localRef);
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
    // Crawled sites save pages as <path>/index.html; serve those for "/path/".
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) fullPath = path.join(fullPath, 'index.html');
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
    return zipDirectory(clonePath, cloneId.split('_')[0]);
}

async function zipDirectory(clonePath, hostname) {
    const zip = new JSZip();
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