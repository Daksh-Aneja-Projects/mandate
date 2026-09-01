/**
 * Hostile conditions.
 *
 * The verification harness runs the app in a well-behaved desktop Chrome. An
 * embedded in-app browser is not that: it is narrow and short, it may block or
 * partition third-party frames, it may refuse third-party font requests, and it
 * may not implement every corner of WebMCP. This script recreates those
 * conditions on purpose and checks the app degrades honestly instead of lying
 * or falling apart.
 *
 *   node tools/hostile-check.js [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:4321';
const PORT = 9336;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'mandate-hostile-'));
const chrome = spawn(CHROME, [
  '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--headless=new', '--hide-scrollbars',
  // an in-app browser is a third-party context by nature
  '--block-third-party-cookies',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' BREAK'} ${name}${detail ? ` - ${detail}` : ''}`);
};

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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description || ex.text);
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');

  const load = async (blocked = []) => {
    await send('Network.setBlockedURLs', { urls: blocked });
    await send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 50; i++) {
      const n = await evaluate(`document.querySelectorAll('.pay').length`).catch(() => 0);
      if (n > 0) return true;
      await sleep(300);
    }
    return false;
  };

  const fits = () => evaluate(`(() => {
    const de = document.documentElement, W = de.clientWidth, H = de.clientHeight;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > W + 1 || r.left < -1) bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]));
    }
    return { W, H, sideways: de.scrollWidth > de.clientWidth + 1, outside: [...new Set(bad)].slice(0, 5) };
  })()`);

  console.log(`\nHostile conditions - ${URL_}`);
  console.log('Proxying an embedded in-app browser. This is NOT ChatGPT\'s browser.\n');

  // --- 1. the partner origin is unreachable ------------------------------
  console.log('1. Partner origin blocked at the network layer');
  await load(['*mandate-screening.vercel.app*']);
  const bureauGone = await evaluate(`
    import('/src/tools.js').then(T => T.bureauReachable()).then(r => r).catch(() => 'threw')`);
  record('the desk still loads without the bureau', await evaluate(`document.querySelectorAll('.pay').length`) > 0);
  record('federation reports unreachable rather than throwing', bureauGone === false, `bureauReachable() = ${bureauGone}`);

  const degraded = await evaluate(`
    document.modelContext.getTools()
      .then(ts => document.modelContext.executeTool(ts.find(t => t.name === 'recheck_screening_with_bureau'), JSON.stringify({ beneficiaryId: 'BEN-06' })))
      .then(r => typeof r === 'string' ? r : JSON.stringify(r))`);
  record('an unreachable bureau says "Not available", never "clear"',
    /Not available/.test(degraded) && !/\bclear as of today\b/i.test(degraded));
  record('the existing hold is explicitly left standing', /hold/i.test(degraded) && /stands/i.test(degraded));

  await evaluate(`document.querySelector('[data-view="authority"]').click()`);
  await sleep(5500);
  const card = await evaluate(`[...document.querySelectorAll('.auth-card')].map(c => c.textContent).find(t => t.includes('Sentinel')) || ''`);
  record('the desk screen tells the human the bureau is unavailable', /Not available/.test(card));

  // --- 2. third-party fonts blocked --------------------------------------
  console.log('\n2. Google Fonts blocked');
  await load(['*fonts.googleapis.com*', '*fonts.gstatic.com*']);
  const noFonts = await fits();
  record('layout survives without the webfonts', !noFonts.sideways && noFonts.outside.length === 0,
    noFonts.outside.length ? noFonts.outside.join(', ') : 'no overflow');
  const fam = await evaluate(`getComputedStyle(document.querySelector('.wordmark')).fontFamily`);
  record('a real fallback face is used, not a default serif', /Inter|Grotesk|system-ui|sans-serif/.test(fam), fam.slice(0, 60));

  // --- 3. phone-sized in-app browser, with an approval waiting -----------
  console.log('\n3. Phone-sized viewport with an approval card open');
  await send('Network.setBlockedURLs', { urls: [] });
  for (const [w, h, label] of [[390, 844, 'phone'], [414, 720, 'in-app with chrome'], [390, 480, 'keyboard open']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
    await load([]);
    await evaluate(`
      import('/src/state.js').then(S => {
        const p = S.payment('PMT-2047');
        S.askHuman({ kind: 'authorize', title: 'Authorise PMT-2047', body: '47,500.00 to Ardent Fabrication Oy',
          note: 'The beneficiary was added yesterday and has not been verified out of band. I would rather you looked at this one.',
          payment: p, controls: S.check(p) });
      })`);
    await sleep(900);
    const dock = await evaluate(`(() => {
      const a = document.querySelector('.ask'); if (!a) return null;
      const r = a.getBoundingClientRect();
      const btns = [...a.querySelectorAll('button')].map(b => { const q = b.getBoundingClientRect();
        return { t: b.textContent.trim().slice(0, 12), inView: q.top >= 0 && q.bottom <= innerHeight && q.right <= innerWidth && q.left >= 0, h: Math.round(q.height) }; });
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
        vh: innerHeight, vw: innerWidth, btns };
    })()`);
    if (!dock) { record(`${label} ${w}x${h}: approval card renders`, false, 'no card found'); continue; }
    const onScreen = dock.top >= 0 && dock.bottom <= dock.vh && dock.left >= 0 && dock.right <= dock.vw;
    const reachable = dock.btns.length > 0 && dock.btns.every((b) => b.inView);
    const tappable = dock.btns.every((b) => b.h >= 24);
    record(`${label} ${w}x${h}: approval card fully on screen`, onScreen, `card ${dock.top}..${dock.bottom} of ${dock.vh}px`);
    record(`${label} ${w}x${h}: every decision button reachable`, reachable,
      dock.btns.map((b) => `${b.t}${b.inView ? '' : ' OFFSCREEN'}`).join(', '));
    record(`${label} ${w}x${h}: buttons are tappable size`, tappable, `heights ${dock.btns.map((b) => b.h).join('/')}px`);
  }

  const broke = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - broke}/${results.length} held up under hostile conditions.\n`);
  process.exitCode = broke ? 1 : 0;
} catch (e) {
  console.error(`\nCould not run: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows lock */ }
}
