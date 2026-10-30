#!/usr/bin/env node

/**
 * ==========================================
 * WEB CLONE AGENT - CLI INTERFACE
 * Usage:
 *   node src/cli/cli.js clone <url> [options]
 *   node src/cli/cli.js crawl <url> [options] [crawl options]
 *   node src/cli/cli.js list
 *   node src/cli/cli.js read <cloneId> [file]
 *   node src/cli/cli.js delete <cloneId>
 *   node src/cli/cli.js zip <cloneId>
 *   node src/cli/cli.js cleanup --max-age <days>
 *
 * Options:
 *   --no-images       Skip image download
 *   --keep-scripts    Keep JavaScript
 *   --json            Output as JSON (default for AI agents)
 *   --zip             Also create ZIP
 *   --output <dir>    Custom output directory (clone is saved outside the
 *                     managed clones/ store, so list/read/delete won't see it)
 *   --no-render       Skip Camoufox full-browser rendering, use plain HTTP fetch
 *
 * Crawl options (same-site pages only; other domains are never followed):
 *   --max-pages <n>   Stop after n pages (default CRAWL_MAX_PAGES, 50)
 *   --max-depth <n>   Link hops from the start page (default CRAWL_MAX_DEPTH, 3)
 *   --concurrency <n> Pages fetched in parallel (default CRAWL_CONCURRENCY, 2)
 *   --delay <ms>      Pause between requests per worker (default CRAWL_DELAY_MS, 250)
 *   --subdomains      Also follow links to subdomains of the start host
 *   --prefix <path>   Only follow pages whose path starts with this (e.g. /blog/)
 *   --exclude <regex> Skip matching URLs (repeatable)
 *   --sitemap <url>   Crawl every page listed in this sitemap (repeatable; sitemap
 *                     indexes and .xml.gz are followed). Without it, sitemaps are
 *                     discovered from robots.txt and /sitemap.xml.
 *   --no-sitemap      Don't seed the crawl from sitemaps
 *   (--max-pages 0 means no page limit)
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { clonePage, cloneSite, listClones, readCloneFile, deleteClone, getCloneZip, cleanupOldClones } from '../core/cloner.js';
import { closeBrowser } from '../core/renderer.js';

dotenv.config();

const args = process.argv.slice(2);
const command = args[0];
const flags = {
    images: !args.includes('--no-images'),
    removeScripts: !args.includes('--keep-scripts'),
    json: args.includes('--json') || true,  // JSON by default for AI agents
    zip: args.includes('--zip'),
    output: args.includes('--output') ? args[args.indexOf('--output') + 1] : null,
    renderMode: args.includes('--no-render') ? 'never' : undefined,
    maxAge: args.includes('--max-age') ? parseFloat(args[args.indexOf('--max-age') + 1]) : null,
    maxPages: numFlag('--max-pages'),
    maxDepth: numFlag('--max-depth'),
    concurrency: numFlag('--concurrency'),
    delayMs: numFlag('--delay'),
    includeSubdomains: args.includes('--subdomains'),
    pathPrefix: args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : null,
    exclude: args.flatMap((a, i) => a === '--exclude' && args[i + 1] ? [args[i + 1]] : []),
    useSitemap: !args.includes('--no-sitemap'),
    sitemapUrls: args.flatMap((a, i) => a === '--sitemap' && args[i + 1] ? [args[i + 1]] : [])
};

function numFlag(name) {
    return args.includes(name) ? parseInt(args[args.indexOf(name) + 1], 10) : undefined;
}

function definedOnly(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));
}

function output(data) {
    console.log(JSON.stringify(data, null, 2));
}

async function main() {
    switch (command) {

        case 'clone': {
            const url = args[1];
            if (!url) { output({ error: 'Usage: cli.js clone <url>' }); process.exit(1); }

            try {
                const result = await clonePage(url, {
                    includeImages: flags.images,
                    removeScripts: flags.removeScripts,
                    saveToDisk: true,
                    createZip: flags.zip,
                    ...(flags.output ? { outputDir: flags.output } : {}),
                    ...(flags.renderMode ? { renderMode: flags.renderMode } : {})
                }, (msg, pct) => {
                    process.stderr.write(`\r[${pct}%] ${msg}          `);
                });
                process.stderr.write('\n');

                output({
                    status: 'success',
                    cloneId: result.cloneId,
                    path: result.outputPath,
                    metadata: result.metadata
                });
            } catch (e) {
                output({ status: 'error', message: e.message });
                process.exit(1);
            }
            break;
        }

        case 'crawl': {
            const url = args[1];
            if (!url) { output({ error: 'Usage: cli.js crawl <url>' }); process.exit(1); }

            try {
                const result = await cloneSite(url, definedOnly({
                    includeImages: flags.images,
                    removeScripts: flags.removeScripts,
                    createZip: flags.zip,
                    outputDir: flags.output,
                    renderMode: flags.renderMode,
                    maxPages: flags.maxPages,
                    maxDepth: flags.maxDepth,
                    concurrency: flags.concurrency,
                    delayMs: flags.delayMs,
                    includeSubdomains: flags.includeSubdomains,
                    pathPrefix: flags.pathPrefix,
                    exclude: flags.exclude,
                    useSitemap: flags.useSitemap,
                    sitemapUrls: flags.sitemapUrls
                }), (msg, pct) => {
                    process.stderr.write(`\r[${pct}%] ${msg}          `);
                });
                process.stderr.write('\n');

                if (result.zipBuffer) {
                    fs.writeFileSync(path.join(process.cwd(), `${result.cloneId}.zip`), result.zipBuffer);
                }
                output({
                    status: 'success',
                    cloneId: result.cloneId,
                    path: result.outputPath,
                    metadata: result.metadata
                });
            } catch (e) {
                output({ status: 'error', message: e.message });
                process.exit(1);
            }
            break;
        }

        case 'list': {
            output({ clones: listClones() });
            break;
        }

        case 'read': {
            const cloneId = args[1];
            const filePath = args[2] || 'index.html';
            if (!cloneId) { output({ error: 'Usage: cli.js read <cloneId> [file]' }); process.exit(1); }

            const content = readCloneFile(cloneId, filePath);
            if (content === null) {
                output({ error: `File not found: ${cloneId}/${filePath}` });
                process.exit(1);
            }
            output({ cloneId, path: filePath, content });
            break;
        }

        case 'delete': {
            const cloneId = args[1];
            if (!cloneId) { output({ error: 'Usage: cli.js delete <cloneId>' }); process.exit(1); }
            output({ deleted: deleteClone(cloneId), cloneId });
            break;
        }

        case 'zip': {
            const cloneId = args[1];
            if (!cloneId) { output({ error: 'Usage: cli.js zip <cloneId>' }); process.exit(1); }

            const zipBuffer = await getCloneZip(cloneId);
            if (!zipBuffer) { output({ error: 'Clone not found' }); process.exit(1); }

            const outPath = path.join(process.cwd(), `${cloneId}.zip`);
            fs.writeFileSync(outPath, zipBuffer);
            output({ status: 'success', zipPath: outPath, sizeBytes: zipBuffer.length });
            break;
        }

        case 'cleanup': {
            if (flags.maxAge === null || Number.isNaN(flags.maxAge)) {
                output({ error: 'Usage: cli.js cleanup --max-age <days>' });
                process.exit(1);
            }
            const removed = cleanupOldClones(flags.maxAge);
            output({ status: 'success', removedCount: removed.length, removed });
            break;
        }

        default: {
            output({
                tool: 'web-clone-agent',
                version: '1.0.0',
                commands: {
                    clone: 'node src/cli/cli.js clone <url> [--no-images] [--keep-scripts] [--zip] [--output <dir>]',
                    crawl: 'node src/cli/cli.js crawl <url> [clone options] [--max-pages <n>] [--max-depth <n>] [--concurrency <n>] [--delay <ms>] [--subdomains] [--prefix <path>] [--exclude <regex>] [--sitemap <url>] [--no-sitemap]',
                    list: 'node src/cli/cli.js list',
                    read: 'node src/cli/cli.js read <cloneId> [filePath]',
                    delete: 'node src/cli/cli.js delete <cloneId>',
                    zip: 'node src/cli/cli.js zip <cloneId>',
                    cleanup: 'node src/cli/cli.js cleanup --max-age <days>'
                }
            });
        }
    }
}

main().finally(closeBrowser);