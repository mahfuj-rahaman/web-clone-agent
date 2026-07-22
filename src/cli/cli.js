#!/usr/bin/env node

/**
 * ==========================================
 * WEB CLONE AGENT - CLI INTERFACE
 * Usage:
 *   node src/cli/cli.js clone <url> [options]
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
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { clonePage, listClones, readCloneFile, deleteClone, getCloneZip, cleanupOldClones } from '../core/cloner.js';

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
    maxAge: args.includes('--max-age') ? parseFloat(args[args.indexOf('--max-age') + 1]) : null
};

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

main();