/**
 * ==========================================
 * RENDERER - full-browser page capture via Camoufox
 * ==========================================
 * Camoufox (https://camoufox.com) has no official Node client, but its
 * "server" mode exposes Playwright's own cross-language websocket protocol,
 * so we connect to it here using playwright-core instead of launching a
 * local browser.
 */

import { firefox } from 'playwright-core';

let browserPromise = null;

function getBrowser(wsEndpoint) {
    if (!browserPromise) {
        browserPromise = firefox.connect(wsEndpoint).catch(err => {
            browserPromise = null; // allow retry on next call
            throw err;
        });
    }
    return browserPromise;
}

/**
 * Renders `targetUrl` in a real browser tab and returns the fully-loaded DOM HTML.
 * Throws on any connection/navigation failure so callers can fall back to a
 * plain HTTP fetch instead of failing the whole clone.
 *
 * The browser context is kept open and returned (with a `close()` to call
 * when done) rather than closed here, because sites that block/hotlink-guard
 * plain HTTP requests (the whole reason we're rendering at all) usually also
 * block a plain Node fetch of their images — the caller should download
 * images through this same context (see `fetchViaContext`) so they carry the
 * same cookies/session/fingerprint that got the page itself past the guard.
 */
export async function renderPage(targetUrl, { wsEndpoint, timeoutMs = 15000 } = {}) {
    if (!wsEndpoint) throw new Error('CAMOUFOX_WS_ENDPOINT is not configured');

    const browser = await getBrowser(wsEndpoint);
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
        } catch {
            // Bulky pages with persistent connections (analytics, polling) may
            // never go network-idle within the budget — settle for "load".
            await page.goto(targetUrl, { waitUntil: 'load', timeout: timeoutMs });
        }
        await autoScroll(page);
        await expandCollapsedContent(page);
        await hoverSweep(page);
        const html = await page.content();
        const finalUrl = page.url();
        return { html, finalUrl, context, close: () => context.close() };
    } catch (e) {
        await context.close();
        throw e;
    }
}

/**
 * Scrolls the page from top to bottom in viewport-sized steps, pausing
 * briefly between each. Many sites reveal below-the-fold content only once
 * it scrolls into view (IntersectionObserver-driven fade-ins, lazy-loaded
 * images/sections) — capturing page.content() right after `goto()` freezes
 * that content in its pre-reveal state (commonly `opacity-0`, or a lazy
 * placeholder), which then becomes permanently invisible once removeScripts
 * strips the JS that would have revealed it. Scrolling through the whole
 * page first gives that JS a chance to run before we capture the DOM.
 */
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            const step = Math.max(window.innerHeight, 400);
            let scrolled = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, step);
                scrolled += step;
                if (scrolled >= document.body.scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 200);
        });
    });
    // Let any final reveal transitions/lazy-loads triggered by the last
    // scroll step settle before scrolling back to the top for the capture.
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
}

// Text/label keywords that disqualify an element from the auto-expand
// click-sweep, even if it otherwise looks like a safe toggle — clicking
// these could have a real side effect rather than just revealing content.
const UNSAFE_CLICK_KEYWORDS = [
    'add to cart', 'buy', 'checkout', 'purchase', 'pay', 'subscribe',
    'delete', 'remove', 'logout', 'log out', 'sign out', 'sign up',
    'submit', 'confirm', 'send', 'unsubscribe', 'cancel'
];

/**
 * Opens native <details> elements and clicks common accordion/collapse
 * toggles so their content shows up in the captured HTML instead of staying
 * collapsed forever once removeScripts strips the JS that would otherwise
 * let a user expand them interactively.
 *
 * Safety: only targets elements matching well-known "expand" patterns
 * (aria-expanded="false", [data-toggle]/[data-bs-toggle] collapse/accordion
 * hooks, common accordion/faq class names), skips anything whose text/label
 * matches UNSAFE_CLICK_KEYWORDS, and skips real navigation — <a> tags with
 * an href that isn't "#" or empty, and type="submit" buttons. Each click is
 * independently wrapped so one bad match can't abort the whole clone, and
 * the sweep is capped to avoid runaway loops on adversarial pages.
 */
async function expandCollapsedContent(page) {
    await page.evaluate(() => {
        document.querySelectorAll('details:not([open])').forEach(d => { d.open = true; });
    });

    await page.evaluate((unsafeKeywords) => {
        const isUnsafe = (el) => {
            const text = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '');
            const lower = text.toLowerCase();
            return unsafeKeywords.some(kw => lower.includes(kw));
        };
        const isRealNavigation = (el) => {
            if (el.tagName === 'A') {
                const href = el.getAttribute('href');
                return href && href !== '#' && !href.startsWith('javascript:');
            }
            return el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit';
        };

        const selector = [
            '[aria-expanded="false"]',
            '[data-toggle="collapse"]', '[data-bs-toggle="collapse"]',
            '[data-toggle="accordion"]', '[data-bs-toggle="accordion"]',
            '.accordion-header', '.accordion-toggle', '.accordion-button',
            '.faq-question', '.faq-toggle', '.collapse-toggle'
        ].join(',');

        const candidates = Array.from(document.querySelectorAll(selector)).slice(0, 200);
        for (const el of candidates) {
            if (isUnsafe(el) || isRealNavigation(el)) continue;
            try { el.click(); } catch { /* ignore — leave collapsed */ }
        }
    }, UNSAFE_CLICK_KEYWORDS);

    await page.waitForTimeout(300);
}

// Elements likely to reveal content on hover via a JS mouseenter/mouseover
// listener (as opposed to pure-CSS :hover, which needs no help — it already
// survives removeScripts since we keep the page's CSS).
const HOVER_TARGET_SELECTOR = [
    '[data-dropdown]', '[data-hover]', '[aria-haspopup="true"]',
    '.dropdown', '.has-submenu', '.has-dropdown', '.menu-item-has-children',
    'nav li:has(> ul)', 'nav li:has(> .submenu)', 'nav li:has(> .dropdown-menu)'
].join(',');

/**
 * Hovers each likely dropdown/tooltip trigger one at a time and, if the
 * hover visibly changed the element (new classes or inline style — the
 * common way JS marks something "open"), permanently re-applies that same
 * class/style so the change survives after the mouse moves on to the next
 * target. This "freezes" one hovered state per element directly into the
 * live DOM before the final page.content() capture, rather than trying to
 * keep multiple mutually-exclusive interactive states in one static snapshot.
 *
 * Best-effort and generic: sites with unusual hover-reveal patterns (e.g. a
 * hover handler that reveals a *different* element than the one hovered)
 * won't be caught by this. Each element is wrapped individually so a
 * misbehaving hover target can't abort the sweep.
 */
async function hoverSweep(page) {
    const count = await page.locator(HOVER_TARGET_SELECTOR).count().catch(() => 0);
    const max = Math.min(count, 50); // cap for pathological pages

    for (let i = 0; i < max; i++) {
        try {
            const target = page.locator(HOVER_TARGET_SELECTOR).nth(i);
            const before = await target.evaluate(el => ({ cls: el.className, style: el.getAttribute('style') || '' }));
            await target.hover({ timeout: 2000, trial: false });
            await page.waitForTimeout(150);
            await target.evaluate((el, before) => {
                const after = { cls: el.className, style: el.getAttribute('style') || '' };
                if (after.cls !== before.cls) el.className = after.cls;
                if (after.style !== before.style) el.setAttribute('style', after.style);
                // Swap in a deep clone of the now-frozen element. cloneNode
                // preserves the current DOM/attribute state but drops any
                // addEventListener-attached mouseenter/mouseleave handlers,
                // so hovering the *next* target can't trigger this one's
                // mouseleave handler and revert what we just froze.
                el.replaceWith(el.cloneNode(true));
            }, before);
        } catch { /* skip this target, keep going */ }
    }
}

/**
 * Fetches `url` through an already-open rendered-page context (same
 * cookies/session as the page that was just rendered), returning a Buffer.
 * Throws on any non-2xx response, matching the plain-HTTP fetchUrl behavior
 * in cloner.js so callers can treat both paths identically.
 */
export async function fetchViaContext(context, url, { timeoutMs = 15000 } = {}) {
    const response = await context.request.get(url, { timeout: timeoutMs });
    if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
    }
    return Buffer.from(await response.body());
}
