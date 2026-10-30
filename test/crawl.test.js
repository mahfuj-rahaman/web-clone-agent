import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { cloneSite, resolveCloneFilePath, CONFIG } from '../src/core/cloner.js';

// Small fixture site: three linked pages, a sitemap-only page, plus links the
// crawler must NOT follow (another domain, a PDF, an admin URL).
let fixtureServer;
let baseUrl;
let tmpDir;
const requests = [];

const page = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title>
<link rel="stylesheet" href="/style.css"></head><body>
<img src="/logo.png">
<a href="/">Home</a> <a href="/about">About</a> <a href="/blog/post-1/#comments">Post</a>
<a href="https://other.example/page">External</a> <a href="/brochure.pdf">PDF</a> <a href="/wp-admin/">Admin</a>
${body}</body></html>`;

const ROUTES = {
    '/': ['text/html', page('Home', '<p>home</p>')],
    '/about': ['text/html', page('About', '<p>about</p>')],
    '/blog/post-1/': ['text/html', page('Post 1', '<a href="../../missing-page">gone</a>')],
    '/hidden': ['text/html', page('Hidden', '<p>only in sitemap</p>')],
    '/secret-a': ['text/html', page('Secret A', '<p>only in custom sitemap</p>')],
    '/secret-b': ['text/html', page('Secret B', '<p>only in custom sitemap</p>')],
    '/robots-only': ['text/html', page('Robots', '<p>only in robots-listed sitemap</p>')],
    '/style.css': ['text/css', 'body { background: url("/logo.png"); }'],
    '/logo.png': ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])]
};

before(async () => {
    fixtureServer = http.createServer((req, res) => {
        requests.push(req.url);
        if (req.url === '/sitemap.xml') {
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(`<urlset><url><loc>${baseUrl}hidden</loc></url></urlset>`);
            return;
        }
        if (req.url === '/custom-index.xml') {
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(`<sitemapindex><sitemap><loc><![CDATA[${baseUrl}pages.xml.gz]]></loc></sitemap></sitemapindex>`);
            return;
        }
        if (req.url === '/pages.xml.gz') {
            res.writeHead(200, { 'Content-Type': 'application/gzip' });
            res.end(zlib.gzipSync(`<urlset><url><loc>${baseUrl}secret-a</loc></url><url><loc>${baseUrl}secret-b</loc></url></urlset>`));
            return;
        }
        if (req.url === '/robots.txt') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(`User-agent: *
Sitemap: ${baseUrl}robots-sitemap.xml
`);
            return;
        }
        if (req.url === '/robots-sitemap.xml') {
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(`<urlset><url><loc>${baseUrl}robots-only</loc></url></urlset>`);
            return;
        }
        const route = ROUTES[req.url];
        if (!route) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': route[0] });
        res.end(route[1]);
    });
    await new Promise(resolve => fixtureServer.listen(0, resolve));
    baseUrl = `http://localhost:${fixtureServer.address().port}/`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-crawl-'));
    CONFIG.clonesDir = tmpDir;
});

after(async () => {
    await new Promise(resolve => fixtureServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cloneSite crawls same-site pages only and rewrites links to local copies', async () => {
    const result = await cloneSite(baseUrl, {
        includeImages: true, removeScripts: true, renderMode: 'never', delayMs: 0
    });
    const read = p => fs.readFileSync(path.join(result.outputPath, p), 'utf-8');
    const saved = result.metadata.pages.map(p => p.path).sort();

    assert.deepEqual(saved, ['about/index.html', 'blog/post-1/index.html', 'hidden/index.html', 'index.html', 'robots-only/index.html']);
    assert.ok(!requests.includes('/brochure.pdf'), 'non-HTML links are not crawled');
    assert.ok(!requests.some(u => u.startsWith('/wp-admin')), 'admin URLs are excluded');
    assert.equal(requests.filter(u => u === '/logo.png').length, 1, 'shared image downloaded once');
    assert.equal(requests.filter(u => u === '/style.css').length, 1, 'shared stylesheet fetched once');
    assert.equal(result.metadata.failed.length, 1, 'the dead link is recorded as failed');

    const post = read('blog/post-1/index.html');
    assert.ok(post.includes('href="../../index.html"'), 'link to home is relative');
    assert.ok(post.includes('href="../../about/index.html"'), 'link to sibling page is relative');
    assert.ok(post.includes('href="./index.html#comments"'), 'self link keeps its fragment');
    assert.ok(post.includes('src="../../logo.png"'), 'image path climbs back to clone root');
    assert.ok(post.includes('href="https://other.example/page"'), 'external link left live');
    assert.ok(read('index.html').includes('href="./about/index.html"'));
    assert.ok(fs.existsSync(path.join(result.outputPath, 'logo.png')));
});

test('cloneSite respects maxPages and pathPrefix', async () => {
    const limited = await cloneSite(baseUrl, { renderMode: 'never', delayMs: 0, maxPages: 2, useSitemap: false });
    assert.equal(limited.metadata.pages.length, 2);

    const blogOnly = await cloneSite(baseUrl + 'blog/post-1/', { renderMode: 'never', delayMs: 0, pathPrefix: '/blog/' });
    assert.deepEqual(blogOnly.metadata.pages.map(p => p.path), ['blog/post-1/index.html']);
    // Root redirect so opening the clone lands on the start page.
    assert.ok(fs.readFileSync(path.join(blogOnly.outputPath, 'index.html'), 'utf-8').includes('blog/post-1/index.html'));
});

test('preview path resolution serves <dir>/index.html for crawled pages', async () => {
    const result = await cloneSite(baseUrl, { renderMode: 'never', delayMs: 0, maxPages: 2, useSitemap: false });
    assert.ok(resolveCloneFilePath(result.cloneId, 'about/')?.endsWith('index.html'));
});

test('cloneSite crawls every page from an explicit sitemap index (gzip child) with no page limit', async () => {
    const result = await cloneSite(baseUrl, {
        renderMode: 'never', delayMs: 0, maxPages: 0, maxDepth: 0,
        sitemapUrls: baseUrl + 'custom-index.xml'
    });
    const saved = result.metadata.pages.map(p => p.path).sort();
    assert.deepEqual(saved, ['index.html', 'secret-a/index.html', 'secret-b/index.html']);
    assert.equal(result.metadata.sitemap.urls, 2);
    assert.equal(result.metadata.sitemap.sources.length, 2);
});
