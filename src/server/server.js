import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { clonePage, listClones, readCloneFile, deleteClone, getCloneZip, resolveCloneFilePath, CONFIG, log } from '../core/cloner.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const API_KEY = process.env.API_KEY || null; // optional; if unset, API is open (local/dev use)
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10', 10);

// ── In-memory per-IP rate limiter for POST /api/clone ──
const cloneHits = new Map(); // ip -> [timestamps]
function isRateLimited(ip) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const hits = (cloneHits.get(ip) || []).filter(t => t > windowStart);
    hits.push(now);
    cloneHits.set(ip, hits);
    return hits.length > RATE_LIMIT_PER_MINUTE;
}

function isAuthorized(req) {
    if (!API_KEY) return true; // auth disabled unless API_KEY is set
    return req.headers['x-api-key'] === API_KEY;
}

function safePublicPath(pathname) {
    const decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const resolved = path.resolve(PUBLIC_DIR, '.' + decoded);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
    return resolved;
}

function sendJSON(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve({}); }
        });
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── REST API ─────────────────────────────────────

    // POST /api/clone — Clone a page
    if (url.pathname === '/api/clone' && req.method === 'POST') {
        if (!isAuthorized(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);

        const ip = req.socket.remoteAddress || 'unknown';
        if (isRateLimited(ip)) return sendJSON(res, { error: 'Rate limit exceeded, try again shortly' }, 429);

        try {
            const body = await parseBody(req);
            const { url: targetUrl, includeImages, removeScripts, createZip, renderMode } = body;

            if (!targetUrl) return sendJSON(res, { error: 'Missing "url"' }, 400);

            const result = await clonePage(targetUrl, {
                includeImages: includeImages ?? CONFIG.defaultIncludeImages,
                removeScripts: removeScripts ?? CONFIG.defaultRemoveScripts,
                saveToDisk: true,
                createZip: createZip || false,
                renderMode: renderMode ?? CONFIG.renderMode
            }, (msg, pct) => log(`[${pct}%] ${msg}`));

            const response = {
                status: 'success',
                cloneId: result.cloneId,
                path: result.outputPath,
                metadata: result.metadata
            };

            if (result.zipBuffer) {
                response.zipBase64 = result.zipBuffer.toString('base64');
            }

            sendJSON(res, response);
        } catch (e) {
            sendJSON(res, { error: e.message }, 500);
        }
        return;
    }

    // GET /api/clones — List all clones
    if (url.pathname === '/api/clones' && req.method === 'GET') {
        sendJSON(res, { clones: listClones() });
        return;
    }

    // GET /api/clones/:id — Get clone metadata
    if (url.pathname.match(/^\/api\/clones\/[^/]+$/) && req.method === 'GET') {
        const cloneId = url.pathname.split('/')[3];
        const clones = listClones().filter(c => c.id === cloneId);
        if (clones.length === 0) return sendJSON(res, { error: 'Not found' }, 404);
        sendJSON(res, clones[0]);
        return;
    }

    // GET /api/clones/:id/file?path=... — Read a file from clone
    if (url.pathname.match(/^\/api\/clones\/[^/]+\/file$/) && req.method === 'GET') {
        const cloneId = url.pathname.split('/')[3];
        const filePath = url.searchParams.get('path') || 'index.html';
        const content = readCloneFile(cloneId, filePath);
        if (content === null) return sendJSON(res, { error: 'File not found' }, 404);
        sendJSON(res, { cloneId, path: filePath, content });
        return;
    }

    // GET /api/clones/:id/zip — Download clone as ZIP
    if (url.pathname.match(/^\/api\/clones\/[^/]+\/zip$/) && req.method === 'GET') {
        const cloneId = url.pathname.split('/')[3];
        const zipBuffer = await getCloneZip(cloneId);
        if (!zipBuffer) return sendJSON(res, { error: 'Not found' }, 404);
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${cloneId}.zip"`,
            'Access-Control-Allow-Origin': '*'
        });
        res.end(zipBuffer);
        return;
    }

    // DELETE /api/clones/:id — Delete a clone
    if (url.pathname.match(/^\/api\/clones\/[^/]+$/) && req.method === 'DELETE') {
        if (!isAuthorized(req)) return sendJSON(res, { error: 'Unauthorized' }, 401);
        const cloneId = url.pathname.split('/')[3];
        const deleted = deleteClone(cloneId);
        sendJSON(res, { deleted, cloneId });
        return;
    }

    // GET /api/config — Frontend config
    if (url.pathname === '/api/config') {
        sendJSON(res, {
            defaultIncludeImages: CONFIG.defaultIncludeImages,
            defaultRemoveScripts: CONFIG.defaultRemoveScripts,
            maxImageSizeBytes: CONFIG.maxImageSizeBytes,
            includedImageExtensions: CONFIG.includedImageExtensions,
            defaultRenderMode: CONFIG.renderMode
        });
        return;
    }

    // GET /preview/:id or /preview/:id/... — Serve a saved clone's own files so it can run locally
    if (url.pathname.match(/^\/preview\/[^/]+(\/.*)?$/) && req.method === 'GET') {
        const parts = url.pathname.split('/'); // '', 'preview', id, ...rest
        const cloneId = decodeURIComponent(parts[2]);
        const rest = parts.slice(3).map(decodeURIComponent).join('/');
        const filePath = resolveCloneFilePath(cloneId, rest || 'index.html');
        if (!filePath) { res.writeHead(404); res.end('Not found'); return; }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
            '.js': 'application/javascript', '.mjs': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
            '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
            '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(fs.readFileSync(filePath));
        return;
    }

    // ── Serve GUI ────────────────────────────────────
    const filePath = safePublicPath(url.pathname);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(fs.readFileSync(filePath));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`✅ Web Clone Agent running at http://localhost:${PORT}`);
    console.log(`   GUI:    http://localhost:${PORT}`);
    console.log(`   API:    http://localhost:${PORT}/api/clone`);
    console.log(`   Clones: ${CONFIG.clonesDir}`);
});