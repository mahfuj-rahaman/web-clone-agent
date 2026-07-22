import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    clonePage,
    listClones,
    readCloneFile,
    deleteClone,
    cleanupOldClones,
    CONFIG
} from '../src/core/cloner.js';

// Fixture server stands in for a real target site so tests don't hit the network.
let fixtureServer;
let baseUrl;
let tmpClonesDir;

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head>
<title>Fixture Page</title>
<link rel="stylesheet" href="/style.css">
<script>console.log('should be removed');</script>
</head>
<body onclick="alert('x')">
<img src="/logo.png">
<div style="background-image:url('/logo.png')"></div>
</body></html>`;

const FIXTURE_CSS = `body { background: url('/logo.png'); }`;
const FIXTURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // minimal PNG-ish bytes

before(async () => {
    fixtureServer = http.createServer((req, res) => {
        if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(FIXTURE_HTML);
        } else if (req.url === '/style.css') {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(FIXTURE_CSS);
        } else if (req.url === '/logo.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(FIXTURE_PNG);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(resolve => fixtureServer.listen(0, resolve));
    baseUrl = `http://localhost:${fixtureServer.address().port}/`;

    tmpClonesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-test-'));
    CONFIG.clonesDir = tmpClonesDir;
});

after(async () => {
    await new Promise(resolve => fixtureServer.close(resolve));
    fs.rmSync(tmpClonesDir, { recursive: true, force: true });
});

test('clonePage strips scripts, inlines CSS, and downloads images', async () => {
    const result = await clonePage(baseUrl, { includeImages: true, removeScripts: true, saveToDisk: true });

    assert.ok(!result.html.includes('<script'), 'scripts should be removed');
    assert.ok(!result.html.includes('onclick'), 'inline event handlers should be removed');
    assert.ok(result.html.includes('<style'), 'CSS should be inlined into a <style> tag');
    assert.equal(result.images.size, 1, 'the one referenced image should be downloaded');
    assert.ok(fs.existsSync(path.join(result.outputPath, 'index.html')));
    assert.ok(fs.existsSync(path.join(result.outputPath, 'metadata.json')));
});

test('clonePage respects a custom outputDir', async () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-custom-'));
    const result = await clonePage(baseUrl, { includeImages: false, saveToDisk: true, outputDir: customDir });
    assert.ok(result.outputPath.startsWith(customDir));
    fs.rmSync(customDir, { recursive: true, force: true });
});

test('listClones finds clones saved under CONFIG.clonesDir', async () => {
    const result = await clonePage(baseUrl, { includeImages: false, saveToDisk: true });
    const clones = listClones();
    assert.ok(clones.some(c => c.id === result.cloneId));
});

test('readCloneFile blocks path traversal', async () => {
    const result = await clonePage(baseUrl, { includeImages: false, saveToDisk: true });
    assert.equal(readCloneFile(result.cloneId, '../../../etc/passwd'), null);
    assert.equal(readCloneFile('../escape', 'index.html'), null);
    assert.ok(readCloneFile(result.cloneId, 'index.html') !== null);
});

test('deleteClone blocks path traversal and reports missing clones', () => {
    assert.equal(deleteClone('../escape'), false);
    assert.equal(deleteClone('does-not-exist'), false);
});

test('cleanupOldClones removes clones older than maxAgeDays', async () => {
    const result = await clonePage(baseUrl, { includeImages: false, saveToDisk: true });
    const metaPath = path.join(result.outputPath, 'metadata.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.clonedAt = new Date(Date.now() - 999 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const removed = cleanupOldClones(1);
    assert.ok(removed.includes(result.cloneId));
    assert.equal(fs.existsSync(result.outputPath), false);
});
