/**
 * Launches real Chrome with the WebMCP flags, loads the app, and asks the
 * browser itself what got registered. The headless stub in test/tools.test.js
 * proves the logic; this proves the browser actually accepted it.
 *
 *   node tools/verify-webmcp.js [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:4321';
const PORT = 9333;
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'mandate-verify-'));
const chrome = spawn(CHROME, [
  '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--headless=new', '--window-size=1600,900',
  URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(URL_.slice(0, 21)));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* chrome not up yet */ }
    await sleep(400);
  }
  throw new Error('Chrome did not expose a debuggable page in 24 seconds.');
}

function cdp(ws) {
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res) => {
    const n = ++id;
    waiting.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

const results = [];
const record = (name, okFn, detail) => {
  results.push({ name, ok: okFn, detail });
  console.log(`${okFn ? '  ok  ' : ' FAIL '} ${name}${detail ? ` - ${detail}` : ''}`);
};

try {
  const page = await target();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description || ex.exception?.value || ex.text);
    return r.result?.result?.value;
  };

  /** The imperative API docs describe executeTool's second argument as a JSON
   *  string while the explainer shows an object. Try both and report which the
   *  browser actually takes, so the README states the truth. */
  const run = async (tool, args) => {
    for (const [shape, arg] of [['object', JSON.stringify(args)], ['json string', JSON.stringify(JSON.stringify(args))]]) {
      try {
        const out = await evaluate(`
          document.modelContext.getTools()
            .then(ts => document.modelContext.executeTool(ts.find(t => t.name === ${JSON.stringify(tool)}), ${arg}))
            .then(r => JSON.stringify(r))`);
        return { shape, out };
      } catch (e) { var last = e; }
    }
    throw last;
  };

  // Wait for the page to finish registering rather than guessing at a delay.
  // Over a network the declarative <form> tool appears as soon as the HTML is
  // parsed, well before the module has run, so counting tools is the only
  // honest readiness signal.
  for (let i = 0; i < 60; i++) {
    const n = await evaluate(`document.modelContext
      ? document.modelContext.getTools().then(t => t.length) : 0`).catch(() => 0);
    if (n >= 15) break;
    await sleep(400);
  }

  console.log(`\nMandate - WebMCP verification against ${page.url}\n`);

  const api = await evaluate(`({
    modelContext: typeof document.modelContext,
    testing: typeof navigator.modelContextTesting,
    registerTool: typeof document.modelContext?.registerTool,
    getTools: typeof document.modelContext?.getTools,
  })`);
  record('document.modelContext is present', api.modelContext === 'object', `got "${api.modelContext}"`);
  record('registerTool is callable', api.registerTool === 'function');
  record('getTools is callable', api.getTools === 'function');

  if (api.modelContext !== 'object') {
    console.log('\nWebMCP is not enabled in this Chrome build. Nothing further can be checked.\n');
    process.exit(1);
  }

  const tools = await evaluate(`document.modelContext.getTools().then(ts => ts.map(t => t.name))`);
  record('the desk registered its tools', Array.isArray(tools) && tools.length >= 15, `${tools?.length} tools`);
  console.log(`        ${tools.join(', ')}`);

  record('the declarative <form> tool registered', tools.includes('ask_the_desk'));
  record('no release_under_mandate before a mandate exists', !tools.includes('release_under_mandate'));

  // Drive a read tool exactly as an agent would.
  const status = await run('get_desk_status', {});
  record('a read tool executes through the browser', /Halden Industries/.test(status.out || ''), `args passed as ${status.shape}`);

  // A consequential tool must refuse rather than move money.
  const refused = await run('release_payment', { id: 'PMT-2041' });
  record('release refuses without a mandate', /Refused/.test(refused.out || '') && /propose_mandate/.test(refused.out || ''));

  const untouched = await evaluate(`document.querySelector('.pay[data-id="PMT-2041"] .tag').textContent.trim()`);
  record('nothing moved on the desk screen', untouched === 'Clear to release', `row reads "${untouched}"`);

  // Grant a mandate through the app's own state, then confirm the browser sees
  // a genuinely different tool list.
  await evaluate(`
    import('/src/state.js').then(async S => {
      S.grantMandate({ perPaymentMinor: 500000, totalMinor: 2000000, ccy: 'EUR',
        rails: ['sepa_ct'], knownBeneficiariesOnly: true, minutes: 30,
        reason: 'verification', grantedBy: 'p.raghavan',
        expiresAt: new Date(Date.now() + 1800000).toISOString() });
      const T = await import('/src/tools.js');
      await T.syncTools();
    })`);
  await sleep(600);

  const after = await evaluate(`document.modelContext.getTools().then(ts => ts.map(t => t.name))`);
  record('granting a mandate adds release_under_mandate', after.includes('release_under_mandate'), `${after.length} tools now`);

  const swept = await run('release_under_mandate', { dryRun: true });
  record('the mandate sweep runs and reports what it would leave', /Would release/.test(swept.out || '') && /Left for a person/.test(swept.out || ''));

  await evaluate(`import('/src/state.js').then(async S => { S.revokeMandate('p.raghavan'); (await import('/src/tools.js')).syncTools(); })`);
  await sleep(600);
  const revoked = await evaluate(`document.modelContext.getTools().then(ts => ts.map(t => t.name))`);
  record('revoking removes it again', !revoked.includes('release_under_mandate'), `${revoked.length} tools`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.\n`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error(`\nVerification could not run: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* windows holds locks briefly */ }
}
