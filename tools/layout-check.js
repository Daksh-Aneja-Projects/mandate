/**
 * Layout check across viewports. Catches the three things a single screenshot
 * at one comfortable width will always hide: the page scrolling sideways,
 * content sitting outside the viewport, and panels overlapping each other when
 * the window is short.
 *
 *   node tools/layout-check.js [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:4321';
const PORT = 9335;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const VIEWPORTS = [
  [1920, 1080, 'desktop wide'],
  [1600, 900, 'desktop'],
  [1440, 900, 'laptop'],
  [1280, 800, 'small laptop'],
  [1200, 630, 'social card crop'],
  [1024, 768, 'narrow'],
  [820, 1180, 'tablet portrait'],
  [390, 844, 'phone'],
];

const profile = mkdtempSync(join(tmpdir(), 'mandate-layout-'));
const chrome = spawn(CHROME, [
  '--enable-features=WebMCPTesting', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--headless=new', '--hide-scrollbars', URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page. Reports anything that breaks out of its bounds.
const PROBE = `(() => {
  const de = document.documentElement;
  const W = de.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > W + 1 || r.left < -1) {
      out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0])
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    }
  }
  // panels must never sit on top of one another
  const panels = [...document.querySelectorAll('.panel')].map(p => ({
    n: p.querySelector('.panel-title')?.textContent.trim().split('\\n')[0] || '?',
    r: p.getBoundingClientRect(),
  }));
  const overlaps = [];
  for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++) {
    const a = panels[i].r, b = panels[j].r;
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 2 && oy > 2) overlaps.push(panels[i].n + ' over ' + panels[j].n);
  }
  return {
    pageScrollsX: de.scrollWidth > de.clientWidth + 1,
    outside: out.slice(0, 6),
    overlaps: overlaps.slice(0, 6),
    rows: document.querySelectorAll('.pay').length,
  };
})()`;

let failures = 0;
try {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up */ }
    if (!page) await sleep(400);
  }
  if (!page) throw new Error('Chrome did not come up.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });

  // Wait for the desk to actually paint before measuring anything. On a cold
  // edge the first viewport can be probed before the module has run, which
  // reads as a layout failure when it is only a slow first byte.
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `document.fonts.ready.then(() => document.querySelectorAll('.pay').length)`,
      awaitPromise: true, returnByValue: true,
    });
    if ((r.result?.result?.value || 0) > 0) break;
    await sleep(300);
  }

  console.log(`\nLayout check - ${URL_}\n`);
  for (const [w, h, label] of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
    await sleep(700);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result?.result?.value;
    if (!v) { console.log(` FAIL  ${w}x${h} ${label} - probe returned nothing`); failures++; continue; }

    const bad = v.pageScrollsX || v.outside.length || v.overlaps.length || v.rows === 0;
    if (bad) failures++;
    console.log(`${bad ? ' FAIL ' : '  ok  '} ${String(w + 'x' + h).padEnd(10)} ${label.padEnd(18)} ${v.rows} rows`);
    if (v.pageScrollsX) console.log('         page scrolls sideways');
    for (const o of v.outside) console.log(`         outside viewport: ${o}`);
    for (const o of v.overlaps) console.log(`         overlap: ${o}`);
  }
  console.log(`\n${VIEWPORTS.length - failures}/${VIEWPORTS.length} viewports clean.\n`);
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.error(`Could not run: ${e.message}`);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
}
