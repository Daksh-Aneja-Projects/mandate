/**
 * Walks the whole recorded demo, in order, in a real browser, clicking the
 * approval buttons rather than resolving them in code. If this passes, the take
 * will work; if it fails, it fails here instead of on camera.
 *
 * Attaches to an already-running Chrome with WebMCP enabled:
 *   chrome --enable-features=WebMCPTesting --remote-debugging-port=9400 <url>
 *   node tools/demo-rehearsal.js [port] [url]
 */
const PORT = Number(process.argv[2]) || 9400;
const URL_ = process.argv[3] || 'https://mandate-webmcp.vercel.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
const step = (n, ok, detail) => {
  steps.push(ok);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${n}${detail ? ` - ${detail}` : ''}`);
};

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  .catch(() => { throw new Error(`No Chrome listening on ${PORT}. Launch it with --remote-debugging-port=${PORT} and WebMCP enabled.`); });
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('No page target found.');

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

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || ex.text);
  return r.result?.result?.value;
};

/** Call a tool exactly as an agent would. */
const call = (name, args = {}) => ev(`
  document.modelContext.getTools()
    .then(ts => document.modelContext.executeTool(ts.find(t => t.name === ${JSON.stringify(name)}), ${JSON.stringify(JSON.stringify(args))}))
    .then(r => typeof r === 'string' ? r : JSON.stringify(r))`);

const until = async (expr, want = true, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const v = await ev(expr).catch(() => null);
    if (want === true ? v : v === want) return v;
    await sleep(400);
  }
  return null;
};

console.log(`\nDemo rehearsal - ${URL_}\n`);
await send('Page.navigate', { url: URL_ });
const ready = await until(`document.modelContext ? document.modelContext.getTools().then(t => t.length >= 15) : false`);
step('page loads and registers its surface', !!ready);
await until(`import('/src/tools.js').then(T => T.bureauReachable())`);

// --- beat 1: it reads the desk -------------------------------------------
const desk = await call('get_desk_status');
step('beat 1: get_desk_status answers', /Halden Industries/.test(desk));
step('beat 1: it says plainly that it cannot move money', /no authority to move money/i.test(desk));

const hold = await call('explain_hold', { id: 'PMT-2048' });
step('beat 1: explain_hold names the sanctions match', /Sanctions screening match/i.test(hold));

// --- beat 2: it reaches into the other company ---------------------------
const bureau = await call('recheck_screening_with_bureau', { beneficiaryId: 'BEN-06' });
step('beat 2: the bureau answers across origins', /match still stands/i.test(bureau));
step('beat 2: the answer is attributed to the other organisation', /different organisation on a different origin/i.test(bureau));

// --- beat 3: it hits the wall --------------------------------------------
const refused = await call('release_payment', { id: 'PMT-2041' });
step('beat 3: release is refused', /^"?Refused/.test(refused) || /Refused\./.test(refused));
step('beat 3: the refusal names segregation of duties', /Segregation of duties/i.test(refused));
step('beat 3: the refusal offers propose_mandate', /propose_mandate/.test(refused));
step('beat 3: nothing moved', await ev(`import('/src/state.js').then(S => S.payment('PMT-2041').status)`) === 'draft');

// --- beat 4: it asks for authority, a person grants it -------------------
await ev(`window.__mandate = null;
  document.modelContext.getTools()
    .then(ts => document.modelContext.executeTool(ts.find(t => t.name === 'propose_mandate'),
      JSON.stringify({ perPayment: '5000.00', total: '50000.00', currency: 'EUR', minutes: 30,
        rails: ['sepa_ct'], knownBeneficiariesOnly: true,
        reason: 'To clear the routine SEPA run before cut-off without interrupting you for each one.' })))
    .then(r => window.__mandate = (typeof r === 'string' ? r : JSON.stringify(r)));
  'started'`);

const card = await until(`!!document.querySelector('.ask [data-x="yes"]')`);
step('beat 4: the mandate card appears for a person', !!card);
step('beat 4: the scope is editable before agreeing',
  await ev(`['per','tot','min'].every(k => !!document.querySelector('.ask input[id^="' + k + '-"]'))`) === true);
step('beat 4: the agent is genuinely still waiting',
  await ev(`window.__mandate === null`) === true);

// a person tightens the ceiling, then grants - by clicking, not by code
await ev(`(() => {
  const per = document.querySelector('.ask input[id^="per-"]'); per.value = '2500.00';
  document.querySelector('.ask [data-x="yes"]').click();
  return true;
})()`);
const granted = await until(`window.__mandate`);
step('beat 4: clicking grant resolves the call the agent is waiting on', !!granted && /granted the mandate/i.test(granted));
step('beat 4: the agent is told the scope was tightened', /tightened/i.test(granted || ''));

const withMandate = await ev(`document.modelContext.getTools().then(ts => ts.map(t => t.name))`);
step('beat 4: release_under_mandate now exists', withMandate.includes('release_under_mandate'), `${withMandate.length} tools`);

// --- beat 5: it works inside the boundary --------------------------------
const swept = await call('release_under_mandate', {});
step('beat 5: the sweep releases what it may', /Released \d+ payment/.test(swept));
step('beat 5: it reports what it left, with reasons', /Left for a person/.test(swept));
step('beat 5: the sanctions-matched payment was not touched',
  await ev(`import('/src/state.js').then(S => S.payment('PMT-2048').status)`) === 'held');
step('beat 5: the tightened ceiling was actually enforced',
  await ev(`import('/src/state.js').then(S => S.payment('PMT-2043').status)`) === 'draft',
  'PMT-2043 is 3,960 - inside the 5,000 asked for, outside the 2,500 granted');

// --- beat 6: I take it back ----------------------------------------------
await ev(`document.querySelector('[data-view="authority"]').click()`);
await sleep(600);
await ev(`document.querySelector('[data-view="queue"]').click()`);
const revoked = await ev(`(() => { const b = document.getElementById('revokeBtn'); if (!b) return 'no button'; b.click(); return 'clicked'; })()`);
step('beat 6: revoke is one click on the desk', revoked === 'clicked');
await sleep(700);
const after = await ev(`document.modelContext.getTools().then(ts => ts.map(t => t.name))`);
step('beat 6: release_under_mandate is gone again', !after.includes('release_under_mandate'), `${after.length} tools`);

const trail = await call('get_audit_trail', { limit: 40 });
step('beat 6: the trail reads as English, naming the agent and the person',
  /agent released PMT-/i.test(trail) && /Priya Raghavan/.test(trail));

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} beats rehearsed clean.\n`);
process.exitCode = failed ? 1 : 0;
ws.close();
