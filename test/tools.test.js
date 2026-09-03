/**
 * Exercises the WebMCP surface end to end against a stub of
 * document.modelContext, so the tools are proven without a browser.
 *
 * The important thing proved here is the mandate mechanic: that the set of
 * registered tools genuinely changes when a person grants or withdraws
 * authority, rather than a tool merely refusing at call time.
 *
 * Run: node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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

const call = async (name, input = {}) => {
  const t = registered.get(name);
  assert.ok(t, `tool "${name}" is not registered`);
  const res = await t.execute(input, {});
  return { text: res.content[0].text, isError: !!res.isError };
};

/** Kick off a tool that will block on a person, then answer as that person. */
async function callAndAnswer(name, input, answer) {
  const p = call(name, input);
  const req = S.state.pending.at(-1);
  assert.ok(req, `${name} should have opened a request for a person to decide`);
  req.resolve(typeof answer === 'function' ? answer(req) : answer);
  return p;
}

await syncTools();

test('the surface registers, and every tool is well formed', () => {
  assert.ok(registered.size >= 15, `expected a substantial surface, got ${registered.size}`);
  for (const [name, t] of registered) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} should be snake_case`);
    assert.ok(t.description && t.description.length > 40, `${name} needs a description an agent can act on`);
    assert.equal(t.inputSchema.type, 'object', `${name} needs an object input schema`);
    assert.equal(typeof t.execute, 'function');
    for (const [k, v] of Object.entries(t.inputSchema.properties || {})) {
      assert.ok(v.type || v.enum, `${name}.${k} needs a type`);
      assert.ok(v.description, `${name}.${k} needs a description`);
    }
    for (const req of t.inputSchema.required || []) {
      assert.ok(t.inputSchema.properties?.[req], `${name} requires "${req}" but does not define it`);
    }
  }
});

test('read tools describe the desk without touching it', async () => {
  const before = JSON.stringify(S.state.payments);
  const status = await call('get_desk_status');
  assert.match(status.text, /Halden Industries/);
  assert.match(status.text, /no authority to move money/i);

  const found = await call('search_payments', { onlyBlocked: true });
  assert.match(found.text, /PMT-2048/, 'the sanctions-matched payment should show as blocked');

  const one = await call('get_payment', { id: 'PMT-2048' });
  assert.match(one.text, /Sanctions screening match/);

  const why = await call('explain_hold', { id: 'PMT-2053' });
  assert.match(why.text, /SEPA Credit Transfer settles EUR only/);

  assert.equal(JSON.stringify(S.state.payments), before, 'read tools must not mutate the desk');
});

test('bad input is rejected with an explanation, not a stack trace', async () => {
  const r = await call('draft_payment', {
    accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-01', amount: 'about five grand', currency: 'EUR', rail: 'sepa_ct',
  });
  assert.ok(r.isError);
  assert.match(r.text, /not an amount I can read/);

  const g = await call('get_payment', { id: 'PMT-9999' });
  assert.ok(g.isError);
  assert.match(g.text, /no payment PMT-9999/);
});

test('an agent cannot release on its own authority, and is told the way forward', async () => {
  const r = await call('release_payment', { id: 'PMT-2041' });
  assert.match(r.text, /^Refused\./);
  assert.match(r.text, /propose_mandate/, 'a refusal must name a route forward');
  assert.equal(S.payment('PMT-2041').status, 'draft', 'nothing may move');
});

test('a person refusing a mandate leaves the agent with nothing', async () => {
  const r = await callAndAnswer('propose_mandate', {
    perPayment: '5000.00', total: '50000.00', currency: 'EUR', minutes: 30,
    rails: ['sepa_ct'], knownBeneficiariesOnly: true, reason: 'To clear the routine SEPA run before cut-off.',
  }, { ok: false, reason: 'refused', text: 'Priya Raghavan refused the mandate.' });

  assert.match(r.text, /refused/i);
  assert.equal(S.state.mandate, null);
  await syncTools();
  assert.equal(registered.has('release_under_mandate'), false);
});

test('granting a mandate changes the tool surface itself', async () => {
  assert.equal(registered.has('release_under_mandate'), false, 'precondition: no mandate tool yet');

  const r = await callAndAnswer('propose_mandate', {
    perPayment: '5000.00', total: '50000.00', currency: 'EUR', minutes: 30,
    rails: ['sepa_ct'], knownBeneficiariesOnly: true, reason: 'To clear the routine SEPA run before cut-off.',
  }, (req) => {
    // the person tightens the ceiling before granting, as the dock allows
    const granted = S.grantMandate({
      perPaymentMinor: 500000, totalMinor: 2000000, ccy: 'EUR',
      rails: req.proposal.rails, knownBeneficiariesOnly: true, minutes: 30,
      reason: req.proposal.reason, grantedBy: 'p.raghavan',
      expiresAt: new Date(S.deskNow().getTime() + 30 * 60000).toISOString(),
    });
    return { ok: true, granted, by: 'p.raghavan' };
  });

  assert.match(r.text, /granted the mandate/);
  assert.match(r.text, /tightened/, 'the agent should be told the scope was narrowed');

  await syncTools();
  assert.ok(registered.has('release_under_mandate'), 'the mandate tool must now exist');
  assert.ok(registered.has('revoke_mandate'));
});

test('a dry run under the mandate moves nothing', async () => {
  const before = S.state.payments.filter((p) => p.status === 'released').length;
  const r = await call('release_under_mandate', { dryRun: true });
  assert.match(r.text, /Would release/);
  assert.match(r.text, /Nothing has moved/);
  assert.equal(S.state.payments.filter((p) => p.status === 'released').length, before);
});

test('the mandate releases only what it covers, and says why it left the rest', async () => {
  const r = await call('release_under_mandate', {});
  assert.match(r.text, /^Released \d+ payment/);

  // inside scope: small, verified beneficiary, SEPA, evidence attached
  assert.equal(S.payment('PMT-2041').status, 'released');
  assert.equal(S.payment('PMT-2045').status, 'released');

  // outside scope, each for its own reason, all still untouched
  assert.equal(S.payment('PMT-2047').status, 'draft', 'unverified beneficiary');
  assert.equal(S.payment('PMT-2048').status, 'held', 'sanctions match');
  assert.equal(S.payment('PMT-2049').status, 'draft', 'above the per-payment ceiling');
  assert.equal(S.payment('PMT-2053').status, 'draft', 'wrong rail for the currency');

  assert.match(r.text, /Left for a person/);
  assert.match(r.text, /PMT-2048/);
});

test('spending is charged against the mandate budget', () => {
  const ms = S.mandateStatus();
  assert.ok(ms.active);
  assert.ok(ms.mandate.spentMinor > 0, 'releases must draw down the budget');
  assert.equal(ms.budgetLeftMinor, ms.mandate.totalMinor - ms.mandate.spentMinor);
});

test('everything the agent did is on the audit trail and reversible', async () => {
  const trail = await call('get_audit_trail', { limit: 50 });
  assert.match(trail.text, /agent released PMT-2041/i);
  assert.ok(S.state.undoStack.length > 0, 'a person must be able to take agent actions back');

  const top = S.state.undoStack[0];
  S.undoLast();
  assert.notEqual(S.state.undoStack[0], top);
});

test('revoking removes the tools that depended on the mandate', async () => {
  S.revokeMandate('p.raghavan');
  await syncTools();
  assert.equal(registered.has('release_under_mandate'), false);
  assert.equal(registered.has('revoke_mandate'), false);

  const r = await call('release_payment', { id: 'PMT-2042' });
  assert.match(r.text, /^Refused\./);
});

test('a request that nobody answers withdraws itself rather than hanging', async () => {
  const p = call('request_authorization', { id: 'PMT-2046', note: 'Invoice is genuine, evidence attached.' });
  const req = S.state.pending.at(-1);
  req.resolve({ ok: false, reason: 'timeout', text: 'Nobody at the desk responded in time, so nothing was done.' });
  const r = await p;
  assert.match(r.text, /nothing was done/i);
  assert.equal(S.payment('PMT-2046').status, 'draft');
});

test('a person authorising through the gate actually releases the payment', async () => {
  const r = await callAndAnswer('request_authorization',
    { id: 'PMT-2046', note: 'Invoice CS-ADHOC is genuine; I attached the contract clause.' },
    { ok: true, by: 'd.aneja', note: 'Confirmed with the supplier by phone.' });

  assert.match(r.text, /Daksh Aneja authorised PMT-2046/);
  assert.match(r.text, /Confirmed with the supplier by phone/);
  assert.equal(S.payment('PMT-2046').status, 'released');
});

test('the agent cannot approve a payment it prepared, even under a mandate', async () => {
  const drafted = await call('draft_payment', {
    accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-01', amount: '900.00',
    currency: 'EUR', rail: 'sepa_ct', reference: 'AGENT-TEST',
  });
  const id = drafted.text.match(/PMT-\d+/)[0];

  S.grantMandate({
    perPaymentMinor: 500000, totalMinor: 2000000, ccy: 'EUR', rails: ['sepa_ct'],
    knownBeneficiariesOnly: true, minutes: 30, reason: 'test',
    grantedBy: 'p.raghavan', expiresAt: new Date(S.deskNow().getTime() + 30 * 60000).toISOString(),
  });
  await syncTools();

  // A mandate lets an agent release what a person prepared. It never lets an
  // agent be both hands on the same payment.
  const r = await call('release_payment', { id });
  assert.match(r.text, /^Refused\./);
  assert.match(r.text, /Four-eyes/i);
  assert.match(r.text, /the agent prepared this payment/i);
  assert.equal(S.payment(id).status, 'draft');

  S.revokeMandate('p.raghavan');
  await syncTools();
});
