/**
 * Development harness. Not shipped, not part of the app.
 *
 * verify-webmcp.js proves the tools *work*. This proves they are *legible*: it
 * hands the real tool surface to a local model as function definitions and
 * checks it picks the right one from a plain English request, the way a judge's
 * agent will have to. A tool that works but that no agent chooses correctly is
 * a tool that fails in the demo.
 *
 *   ollama serve
 *   node tools/agent-legibility.js [model]
 */
const MODEL = process.argv[2] || 'llama3.1:8b';
const HOST = 'http://127.0.0.1:11434';   // the IPv4 literal on purpose

const registered = new Map();
globalThis.document = {
  modelContext: {
    registerTool(tool, { signal } = {}) {
      registered.set(tool.name, tool);
      signal?.addEventListener('abort', () => registered.delete(tool.name));
      return Promise.resolve();
    },
  },
};

const S = await import('../src/state.js');
const { syncTools } = await import('../src/tools.js');
await syncTools();

/** What a person would actually type, and the tools that would be a fair answer. */
const CASES = [
  ['What is blocking the payment run this morning?', ['get_desk_status', 'search_payments', 'explain_hold']],
  ['Show me everything still waiting to go out on SEPA Credit Transfer.', ['search_payments']],
  ['Why can PMT-2048 not go out?', ['explain_hold', 'get_payment']],
  ['Am I allowed to release payments myself, or do I need to ask someone?', ['explain_my_limits', 'get_mandate']],
  ['How much cash is actually free on the EUR account after what is already committed?', ['get_exposure']],
  ['Prepare a payment of 1200.50 to Northwind GmbH from the EUR account on SEPA, reference INV-99.', ['draft_payment']],
  ['Ask Priya to approve PMT-2046, the evidence is genuine.', ['request_authorization']],
  ['Ask me for the authority you would need to clear the small routine ones yourself.', ['propose_mandate']],
  ['Send PMT-2041 out now.', ['release_payment']],
  ['Who is Ardent Fabrication and have they been verified?', ['search_beneficiaries']],
  ['Attach invoice INV-CS-20551 to PMT-2046 as supporting evidence.', ['attach_evidence']],
  ['What has happened on this desk today?', ['get_audit_trail']],
  ['PMT-2053 is on the wrong rail, move it to Faster Payments.', ['amend_payment']],
  ['That was a mistake, get the last thing you did reversed.', ['undo_last_agent_action']],
  ['I need a human to tell you whether this supplier relationship is genuine.', ['ask_the_desk', 'request_authorization']],
];

/** The declarative <form> tool is registered by the browser from HTML, so the
 *  headless stub never sees it. Mirror it here or the test is unfair to itself:
 *  the model cannot choose a tool it was never shown. Kept in step with the
 *  toolname/tooldescription attributes in index.html. */
const DECLARATIVE = {
  type: 'function',
  function: {
    name: 'ask_the_desk',
    description: 'Put a question or a recommendation in front of whoever is at the desk right now and wait for their written answer. Use this when you need a human judgement that is not itself a payment approval, for example whether a supplier relationship is genuine or which of two invoices is the correct one.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question to put to the person at the desk, in plain language.' } },
      required: ['question'],
    },
  },
};

const asOllamaTools = () => [...[...registered.values()].map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
})), DECLARATIVE];

async function pick(prompt, tools) {
  const r = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      keep_alive: '30m',
      stream: false,
      options: { temperature: 0 },
      tools,
      messages: [
        { role: 'system', content: 'You operate a bank payment desk through the tools provided. Call exactly one tool that best answers the user. Do not answer in prose.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Ollama returned ${r.status}. Is it running?`);
  const j = await r.json();
  return j.message?.tool_calls?.[0]?.function?.name ?? null;
}

const tools = asOllamaTools();
console.log(`\nAgent legibility - ${MODEL} choosing from ${tools.length} tools\n`);

let hit = 0;
const misses = [];
for (const [prompt, accept] of CASES) {
  let chose;
  try { chose = await pick(prompt, tools); }
  catch (e) { console.error(`  ERROR ${e.message}`); process.exit(1); }
  const ok = chose && accept.includes(chose);
  if (ok) hit++; else misses.push({ prompt, chose, accept });
  console.log(`${ok ? '  ok  ' : ' MISS '} ${(chose || 'no tool called').padEnd(24)} ${prompt.slice(0, 62)}`);
}

if (misses.length) {
  console.log('\nMisses, with what a fair answer would have been:');
  for (const m of misses) console.log(`  "${m.prompt}"\n    chose ${m.chose || 'nothing'}, expected one of ${m.accept.join(' / ')}`);
}
console.log(`\n${hit}/${CASES.length} chosen correctly.\n`);
process.exitCode = hit / CASES.length >= 0.8 ? 0 : 1;
