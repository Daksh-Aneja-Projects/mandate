/**
 * Capture the social preview image. It is a real screenshot of the running
 * desk, not a mocked-up graphic, so what a link preview shows is what a visitor
 * actually gets.
 *
 *   node tools/shot.js [url] [outfile]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:4321';
const OUT = process.argv[3] || 'og.png';
const PORT = 9334;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'mandate-shot-'));
const chrome = spawn(CHROME, [
  '--enable-features=WebMCPTesting',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--headless=new', '--hide-scrollbars',
  '--window-size=1200,630', '--force-device-scale-factor=2',
  URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!page) await sleep(400);
  }
  if (!page) throw new Error('Chrome did not come up.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; waiting.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 630, deviceScaleFactor: 2, mobile: false,
  });

  // Wait for the surface to register and the fonts to land, so the shot shows
  // the desk as a visitor sees it rather than a half-painted frame.
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', {
      expression: `document.fonts.ready.then(() => document.querySelectorAll('.pay').length)`,
      awaitPromise: true, returnByValue: true,
    });
    if ((r.result?.result?.value || 0) > 0) break;
    await sleep(300);
  }
  await sleep(1400); // let the entry animations settle

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = shot.result?.data;
  if (!data) throw new Error('Chrome returned no image data.');
  writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log(`Wrote ${OUT} (${(Buffer.from(data, 'base64').length / 1024).toFixed(0)} KB) from ${URL_}`);
} catch (e) {
  console.error(`Could not capture: ${e.message}`);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
}
