#!/usr/bin/env node

/**
 * ==========================================
 * WEB CLONE AGENT - MCP SERVER
 * Exposes cloning tools to AI agents via
 * Model Context Protocol (stdio transport)
 *
 * Add to your AI agent's MCP config:
 * {
 *   "mcpServers": {
 *     "web-clone-agent": {
 *       "command": "docker",
 *       "args": ["exec", "-i", "web-clone-agent", "node", "src/mcp/mcp-server.js"]
 *     }
 *   }
 * }
 */

import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { clonePage, listClones, readCloneFile, deleteClone, getCloneZip } from '../core/cloner.js';

dotenv.config();

const server = new McpServer({
    name: process.env.MCP_SERVER_NAME || 'web-clone-agent',
    version: process.env.MCP_SERVER_VERSION || '1.0.0'
});

// ─── Tool: clone_page ────────────────────────────────
server.tool(
    'clone_page',
    'Clone a complete web page with all assets (HTML, CSS inlined, images downloaded). Returns file paths and metadata for reconstruction.',
    {
        url: z.string().describe('The URL of the page to clone'),
        includeImages: z.boolean().optional().default(true).describe('Download and save all images locally'),
        removeScripts: z.boolean().optional().default(true).describe('Remove JavaScript for clean static clone'),
        createZip: z.boolean().optional().default(false).describe('Also create a ZIP archive'),
        renderMode: z.enum(['auto', 'always', 'never']).optional().describe(
            'auto (default): render with Camoufox (full browser) and fall back to a plain HTTP fetch if unavailable — best for JS-heavy/bulky pages. ' +
            'always: fail if Camoufox is unreachable, never silently degrade. never: skip rendering, use the plain HTTP fetch only.'
        )
    },
    async ({ url, includeImages, removeScripts, createZip, renderMode }) => {
        try {
            const result = await clonePage(url, {
                includeImages,
                removeScripts,
                saveToDisk: true,
                createZip,
                ...(renderMode ? { renderMode } : {})
            });

            const summary = [
                `✅ Cloned: ${url}`,
                `   Clone ID: ${result.cloneId}`,
                `   Path: ${result.outputPath}`,
                `   Title: ${result.metadata.title}`,
                `   Images: ${result.metadata.files.images.length}`,
                `   Total files: ${result.metadata.files.total}`,
                ``,
                `   Files:`,
                `   ├── index.html`,
                ...result.metadata.files.images.map((img, i) =>
                    `   ${i === result.metadata.files.images.length - 1 ? '└' : '├'}── ${img}`
                ),
                ``,
                `   Use read_clone_file to read any file.`
            ].join('\n');

            return { content: [{ type: 'text', text: summary }] };
        } catch (e) {
            return { content: [{ type: 'text', text: `❌ Clone failed: ${e.message}` }], isError: true };
        }
    }
);

// ─── Tool: list_clones ───────────────────────────────
server.tool(
    'list_clones',
    'List all previously cloned pages with their metadata.',
    {},
    async () => {
        const clones = listClones();
        if (clones.length === 0) {
            return { content: [{ type: 'text', text: 'No clones found. Use clone_page to create one.' }] };
        }
        const text = clones.map(c =>
            `• ${c.id}\n  URL: ${c.metadata?.url || 'N/A'}\n  Title: ${c.metadata?.title || 'N/A'}\n  Images: ${c.metadata?.files?.images?.length || 0}\n  Cloned: ${c.metadata?.clonedAt || 'N/A'}`
        ).join('\n\n');
        return { content: [{ type: 'text', text }] };
    }
);

// ─── Tool: read_clone_file ───────────────────────────
server.tool(
    'read_clone_file',
    'Read a specific file from a cloned page (e.g., index.html, metadata.json, or an image path).',
    {
        cloneId: z.string().describe('The clone ID (e.g., www.example.com_2026-07-22T14-30-52)'),
        filePath: z.string().optional().default('index.html').describe('Path to the file within the clone')
    },
    async ({ cloneId, filePath }) => {
        const content = readCloneFile(cloneId, filePath);
        if (content === null) {
            return { content: [{ type: 'text', text: `File not found: ${cloneId}/${filePath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: content }] };
    }
);

// ─── Tool: delete_clone ──────────────────────────────
server.tool(
    'delete_clone',
    'Delete a cloned page and all its files.',
    { cloneId: z.string().describe('The clone ID to delete') },
    async ({ cloneId }) => {
        const deleted = deleteClone(cloneId);
        return {
            content: [{ type: 'text', text: deleted ? `✅ Deleted: ${cloneId}` : `❌ Not found: ${cloneId}` }]
        };
    }
);

// ─── Start MCP Server ────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('✅ MCP Server running (stdio)');
}

main();