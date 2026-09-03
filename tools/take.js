/**
 * The recorded take. Drives the real desk in a real Chrome as a real agent
 * would - every action below is `document.modelContext.executeTool`, the same
 * path a visiting agent uses - but paced for camera rather than for a test
 * runner, against the timecodes in DEMO-SCRIPT.md.
 *
 *   node tools/take.js reset [port] [url]   put the desk back to a clean slate
 *   node tools/take.js go    [port] [url]   run the take (~2:50)
 *
 * Chrome must already be running with WebMCP enabled and a debugging port:
 *   chrome --enable-features=WebMCPTesting --remote-debugging-port=9400 <url>
 */
const MODE = process.argv[2] || 'go';
const PORT = Number(process.argv[3]) || 9400;
const URL_ = process.argv[4] || 'https://mandate-webmcp.vercel.app';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = Date.now();
const tc = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const say = (m) => console.log(`[${tc()}] ${m}`);
/** Sleep until the take clock reaches `sec`, so drift never accumulates. */
const until_t = async (sec) => {
  const wait = t0 + sec * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
};

// ---------------------------------------------------------------- transport
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  .catch(() => { throw new Error(`No Chrome on ${PORT}. Launch it with --remote-debugging-port=${PORT} and WebMCP enabled.`); });
const page = list.find((t) => t.type === 'page' && t.url.startsWith(URL_.replace(/\/$/, '')));
if (!page) throw new Error(`No tab open on ${URL_}.`);

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
await send('Runtime.enable');
await send('Page.enable');
await send('Input.enable').catch(() => {});

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text);
  return r.result?.result?.value;
};

const poll = async (expr, tries = 50, gap = 300) => {
  for (let i = 0; i < tries; i++) {
    const v = await ev(expr).catch(() => null);
    if (v) return v;
    await sleep(gap);
  }
  return null;
};

/** Call a tool exactly as an agent does, through the browser's own API. */
const call = async (name, args = {}) => {
  const out = await ev(`
    document.modelContext.getTools()
      .then(ts => document.modelContext.executeTool(ts.find(t => t.name === ${JSON.stringify(name)}), ${JSON.stringify(JSON.stringify(args))}))
      .then(r => typeof r === 'string' ? r : JSON.stringify(r))`);
  const first = String(out).replace(/^"|"$/g, '').split('\\n')[0].split('\n')[0];
  say(`  -> ${name}: ${first.slice(0, 96)}`);
  return out;
};

/** Move the pointer over an element so its hover state reads on camera. */
const hover = async (sel) => {
  const box = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null; const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 24) }); })()`);
  if (!box) return;
  const { x, y } = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
};

const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return 'missing'; e.click(); return 'ok'; })()`);

const toolCount = () => ev(`document.modelContext.getTools().then(ts => ts.length)`);

/** Type into a focused field one character at a time, the way a person does. */
const typeInto = async (sel, text) => {
  await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus();
    e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  for (const ch of text) {
    await send('Input.insertText', { text: ch });
    await sleep(90);
  }
};

// ------------------------------------------------------------------- ready
const ready = async () => {
  const ok = await poll(`document.modelContext ? document.modelContext.getTools().then(t => t.length >= 15) : false`);
  if (!ok) throw new Error('WebMCP surface never registered. Wrong Chrome window, or the flag is off.');
  const bureau = await poll(`import('/src/tools.js').then(T => T.bureauReachable())`, 30);
  if (!bureau) console.warn('  !! the screening bureau is NOT reachable - beat 2 will degrade');
  return { tools: await toolCount(), bureau: !!bureau };
};

if (MODE === 'reset') {
  await send('Page.navigate', { url: URL_ });
  await sleep(1200);
  const s = await ready();
  console.log(`\nClean slate. ${s.tools} tools registered, bureau ${s.bureau ? 'reachable' : 'UNREACHABLE'}.`);
  console.log('Desk is on the payment queue, nothing selected. Ready to record.\n');
  ws.close();
  process.exit(0);
}

// -------------------------------------------------------------------- take
const pre = await ready();
if (pre.tools !== 18) {
  console.error(`\nRefusing to start: ${pre.tools} tools registered, expected 18.`);
  console.error('The desk is not on a clean slate. Run:  node tools/take.js reset\n');
  ws.close();
  process.exit(1);
}
const dirty = await ev(`import('/src/state.js').then(S => S.payment('PMT-2041').status)`);
if (dirty !== 'draft') {
  console.error(`\nRefusing to start: PMT-2041 is "${dirty}", not "draft". Run:  node tools/take.js reset\n`);
  ws.close();
  process.exit(1);
}

console.log('\n=============== TAKE RUNNING - do not touch the mouse ===============\n');
t0 = Date.now(); // the take clock starts here, not at pre-flight

// --- beat 0 - the desk ------------------------------------------- 0:00-0:14
say('BEAT 0  the desk');
await sleep(2500);
await hover('#queue li:nth-child(2)');
await sleep(1800);
await hover('#queue li:nth-child(5)');
await sleep(1800);
await hover('#rails li:nth-child(1)');
await sleep(2200);
await hover('#caps');
say('  (resting on "What the agent can do now")');

// --- beat 1 - it reads the desk ---------------------------------- 0:14-0:40
await until_t(14);
say('BEAT 1  it reads the desk');
await call('get_desk_status');
await until_t(23);
await call('explain_hold', { id: 'PMT-2048' });
await until_t(31);
await call('explain_hold', { id: 'PMT-2053' });

// --- beat 2 - it reaches into another company -------------------- 0:40-1:02
await until_t(40);
say('BEAT 2  it reaches across origins into the screening bureau');
await call('recheck_screening_with_bureau', { beneficiaryId: 'BEN-06' });

// --- beat 3 - it hits the wall ----------------------------------- 1:02-1:24
await until_t(62);
say('BEAT 3  it tries to move money, and the page refuses');
await call('release_payment', { id: 'PMT-2041' });
const stillDraft = await ev(`import('/src/state.js').then(S => S.payment('PMT-2041').status)`);
say(`  PMT-2041 is still "${stillDraft}" - nothing moved`);

// --- beat 4 - it asks for authority ------------------------------ 1:24-2:02
await until_t(84);
say('BEAT 4  it asks a person for a bounded mandate');
await ev(`window.__mandate = null;
  document.modelContext.getTools()
    .then(ts => document.modelContext.executeTool(ts.find(t => t.name === 'propose_mandate'),
      JSON.stringify({ perPayment: '5000.00', total: '50000.00', currency: 'EUR', minutes: 30,
        rails: ['sepa_ct'], knownBeneficiariesOnly: true,
        reason: 'To clear the routine SEPA run before cut-off without interrupting you for each one.' })))
    .then(r => window.__mandate = (typeof r === 'string' ? r : JSON.stringify(r)));
  'started'`);

const card = await poll(`!!document.querySelector('.ask [data-x="yes"]')`, 30);
if (!card) throw new Error('The mandate card never appeared.');
say('  the card is up, and the agent is still waiting on it');
await sleep(6000);

await hover('.ask input[id^="per-"]');
await sleep(1200);
say('  a person tightens the ceiling: 5000.00 -> 2500.00');
await typeInto('.ask input[id^="per-"]', '2500.00');
await sleep(2500);

// the other knobs are editable too - show them before agreeing
await hover('.ask input[id^="tot-"]');
await sleep(2200);
await hover('.ask input[id^="min-"]');
await sleep(2200);

await until_t(105);
await hover('.ask [data-x="yes"]');
await sleep(1200);
say('  granting');
await click('.ask [data-x="yes"]');
const granted = await poll(`window.__mandate`, 30);
say(`  the waiting call resolved: ${String(granted).replace(/^"/, '').split('\\n')[0].slice(0, 90)}`);

await poll(`document.modelContext.getTools().then(ts => ts.length >= 20)`, 25);
say(`  TOOL SURFACE: ${pre.tools} -> ${await toolCount()}  (release_under_mandate now exists)`);
await hover('#caps');

// --- beat 5 - it works inside the boundary ----------------------- 2:02-2:30
await until_t(122);
say('BEAT 5  it clears only what it is allowed to');
await call('release_under_mandate', {});
const held = await ev(`import('/src/state.js').then(S => S.payment('PMT-2048').status)`);
const ceil = await ev(`import('/src/state.js').then(S => S.payment('PMT-2043').status)`);
say(`  PMT-2048 (sanctions) is "${held}", PMT-2043 at 3,960 is "${ceil}" - the tightening held`);

// show what moved, then what it deliberately left behind
await until_t(130);
await click('[data-filter="done"]');
say('  filter: Released - what the agent cleared');
await until_t(139);
await click('[data-filter="draft"]');
say('  filter: Awaiting release - what it left, each with a reason');
await until_t(147);
await click('[data-filter="all"]');

// --- beat 6 - I take it back ------------------------------------- 2:30-2:55
await until_t(150);
say('BEAT 6  the person revokes, mid-session');
await hover('#revokeBtn');
await sleep(900);
await click('#revokeBtn');
await sleep(1400);
say(`  TOOL SURFACE: back to ${await toolCount()}  (release_under_mandate is gone)`);
await sleep(2500);

await click('[data-view="trail"]');
say('  audit trail, in English, naming who did what');
await until_t(170);
console.log('\n=============== TAKE COMPLETE - stop recording ===============\n');
console.log(`Runtime: ${tc()}`);
ws.close();
