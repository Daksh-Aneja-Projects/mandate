/**
 * The control engine is the part of Mandate that must not be theatre, so it is
 * the part that gets tested. Run: node --test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, mandateCovers, RAILS, ROLES, money } from '../src/controls.js';

const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

const world = (over = {}) => ({
  now: at(10, 0),
  beneficiaries: [
    { id: 'B1', name: 'Verified Co', status: 'verified', screening: 'clear', verifiedOn: '2025-01-01', priorPayments: 10, addedDaysAgo: 400 },
    { id: 'B2', name: 'New Co', status: 'unverified', screening: 'clear', verifiedOn: null, priorPayments: 0, addedDaysAgo: 1 },
    { id: 'B3', name: 'Flagged Co', status: 'unverified', screening: 'match', screeningNote: 'sanctions entry', addedDaysAgo: 2 },
  ],
  accounts: [{ id: 'A1', label: 'EUR Op', ccy: 'EUR', availableMinor: 1_000_000_00 }],
  payments: [],
  approvals: {},
  mandate: null,
  ...over,
});

const pmt = (over = {}) => ({
  id: 'P1', accountId: 'A1', beneficiaryId: 'B1', amountMinor: 1_000_00, ccy: 'EUR',
  rail: 'sepa_ct', status: 'draft', createdBy: 'maker', updatedAt: at(9).toISOString(),
  evidence: [{ label: 'INV-1' }], ...over,
});

const find = (r, id) => r.controls.find((c) => c.id === id);

test('money never floats', () => {
  assert.equal(money(4_820_00, 'EUR'), '€4,820.00');
  assert.equal(money(1, 'EUR'), '€0.01');
});

test('four-eyes blocks the maker approving their own payment', () => {
  const r = evaluate(pmt({ createdBy: 'alice' }), { id: 'alice', role: 'officer' }, world());
  assert.equal(find(r, 'four_eyes').status, 'block');
  assert.equal(r.decision, 'blocked');
});

test('four-eyes passes for a different person', () => {
  const r = evaluate(pmt({ createdBy: 'alice' }), { id: 'bob', role: 'officer' }, world());
  assert.equal(find(r, 'four_eyes').status, 'pass');
});

test('an analyst has no approval authority at all', () => {
  const r = evaluate(pmt(), { id: 'jo', role: 'analyst' }, world());
  assert.equal(find(r, 'authority').status, 'block');
});

test('an agent with no mandate is blocked by segregation of duties, with a route forward', () => {
  const r = evaluate(pmt(), { id: 'agent', role: 'agent' }, world());
  const sod = find(r, 'sod');
  assert.equal(sod.status, 'block');
  assert.ok(sod.remedies.some((x) => x.tool === 'propose_mandate'), 'refusal must offer a path forward');
});

test('an agent inside a live mandate is allowed', () => {
  const m = {
    grantedBy: 'd.aneja', grantedAt: at(9).toISOString(), expiresAt: at(23).toISOString(),
    perPaymentMinor: 5_000_00, totalMinor: 50_000_00, spentMinor: 0, ccy: 'EUR',
    rails: ['sepa_ct'], knownBeneficiariesOnly: true,
  };
  const r = evaluate(pmt(), { id: 'agent', role: 'agent' }, world({ mandate: m }));
  assert.equal(find(r, 'mandate_scope').status, 'pass');
  assert.equal(find(r, 'four_eyes').status, 'pass', 'the mandate granter is the second pair of eyes');
  assert.equal(r.decision, 'allow', 'a clean payment inside a mandate should clear');
});

test('a mandate cannot stand in for four-eyes when the granter is also the maker', () => {
  const m = {
    grantedBy: 'maker', grantedAt: at(9).toISOString(), expiresAt: at(23).toISOString(),
    perPaymentMinor: 5_000_00, totalMinor: 50_000_00, spentMinor: 0, ccy: 'EUR',
    rails: ['sepa_ct'], knownBeneficiariesOnly: true,
  };
  const r = evaluate(pmt({ createdBy: 'maker' }), { id: 'agent', role: 'agent' }, world({ mandate: m }));
  assert.equal(find(r, 'mandate_scope').status, 'pass', 'scope is fine; it is four-eyes that fails');
  assert.equal(find(r, 'four_eyes').status, 'block');
  assert.equal(r.decision, 'blocked');
});

test('a mandate does not stretch: cap, budget, rail, expiry, unverified beneficiary', () => {
  const base = {
    grantedBy: 'd.aneja', grantedAt: at(9).toISOString(), expiresAt: at(23).toISOString(),
    perPaymentMinor: 5_000_00, totalMinor: 50_000_00, spentMinor: 0, ccy: 'EUR',
    rails: ['sepa_ct'], knownBeneficiariesOnly: true,
  };
  const w = world();
  assert.equal(mandateCovers(base, pmt({ amountMinor: 5_000_01 }), w).ok, false, 'per-payment cap');
  assert.equal(mandateCovers({ ...base, spentMinor: 49_000_00 }, pmt({ amountMinor: 2_000_00 }), w).ok, false, 'budget');
  assert.equal(mandateCovers(base, pmt({ rail: 'swift' }), w).ok, false, 'rail scope');
  const xccy = mandateCovers(base, pmt({ ccy: 'GBP', amountMinor: 100_00 }), w);
  assert.equal(xccy.ok, false, 'a EUR mandate must not authorise a GBP payment, however small');
  assert.match(xccy.why, /does not carry across currencies/);
  assert.equal(mandateCovers({ ...base, expiresAt: at(9, 30).toISOString() }, pmt(), w).ok, false, 'expiry');
  assert.equal(mandateCovers(base, pmt({ beneficiaryId: 'B2' }), w).ok, false, 'unverified beneficiary');
  assert.equal(mandateCovers({ ...base, revokedAt: at(9, 50).toISOString() }, pmt(), w), null, 'revoked reads as no mandate');
});

test('single-payment ceiling is enforced per role', () => {
  const big = pmt({ amountMinor: ROLES.officer.singleMinor + 1 });
  assert.equal(find(evaluate(big, { id: 'bob', role: 'officer' }, world()), 'limit_single').status, 'block');
  assert.equal(find(evaluate(big, { id: 'dax', role: 'controller' }, world()), 'limit_single').status, 'pass');
});

test('daily cumulative authority accrues across approvals', () => {
  const approvals = { X: [{ by: 'bob', at: at(9).toISOString(), amountMinor: 24_900_000 }] };
  const r = evaluate(pmt({ amountMinor: 200_000 }), { id: 'bob', role: 'officer' }, world({ approvals }));
  assert.equal(find(r, 'limit_daily').status, 'block');
});

test('payments above the dual-authorisation threshold need a second, distinct approver', () => {
  const p = pmt({ amountMinor: ROLES.officer.dualThresholdMinor + 1, createdBy: 'maker' });
  const one = evaluate(p, { id: 'bob', role: 'officer' }, world());
  assert.equal(find(one, 'dual_auth').status, 'warn');

  const w = world({ approvals: { P1: [{ by: 'carol', at: at(9).toISOString(), amountMinor: p.amountMinor }] } });
  assert.equal(find(evaluate(p, { id: 'bob', role: 'officer' }, w), 'dual_auth').status, 'pass');

  // the maker's own signature must not count as the second approver
  const wMaker = world({ approvals: { P1: [{ by: 'maker', at: at(9).toISOString(), amountMinor: p.amountMinor }] } });
  assert.equal(find(evaluate(p, { id: 'bob', role: 'officer' }, wMaker), 'dual_auth').status, 'warn');
});

test('a sanctions match is a hard block even for a controller', () => {
  const r = evaluate(pmt({ beneficiaryId: 'B3' }), { id: 'dax', role: 'controller' }, world());
  assert.equal(find(r, 'screening').status, 'block');
  assert.equal(r.decision, 'blocked');
});

test('an unverified beneficiary warns rather than blocks, and needs a person', () => {
  const r = evaluate(pmt({ beneficiaryId: 'B2' }), { id: 'bob', role: 'officer' }, world());
  assert.equal(find(r, 'beneficiary').status, 'warn');
  assert.equal(r.decision, 'needs_human');
});

test('available balance is net of what the rest of the queue has already pledged', () => {
  const w = world({
    payments: [{ id: 'P9', accountId: 'A1', amountMinor: 999_000_00, status: 'authorized' }],
  });
  const r = evaluate(pmt({ amountMinor: 2_000_00 }), { id: 'bob', role: 'officer' }, w);
  assert.equal(find(r, 'funding').status, 'block');
  assert.match(find(r, 'funding').explain, /pledged/);
});

test('a rail that does not carry the currency is blocked', () => {
  const r = evaluate(pmt({ ccy: 'GBP', rail: 'sepa_ct' }), { id: 'bob', role: 'officer' }, world());
  assert.equal(find(r, 'rail').status, 'block');
});

test('cut-off warns after close and passes before it', () => {
  const before = evaluate(pmt(), { id: 'bob', role: 'officer' }, world({ now: at(10, 0) }));
  assert.equal(find(before, 'cutoff').status, 'pass');
  const after = evaluate(pmt(), { id: 'bob', role: 'officer' }, world({ now: at(17, 0) }));
  assert.equal(find(after, 'cutoff').status, 'warn');
  assert.match(find(after, 'cutoff').explain, /next business day/);
  // a 24/7 rail has no cut-off to miss
  const fps = evaluate(pmt({ ccy: 'GBP', rail: 'fps' }), { id: 'bob', role: 'officer' }, world({ now: at(23, 0) }));
  assert.equal(find(fps, 'cutoff').status, 'pass');
});

test('a same-amount same-beneficiary payment inside 24h is flagged as a possible duplicate', () => {
  const w = world({
    payments: [{ id: 'P0', beneficiaryId: 'B1', amountMinor: 1_000_00, ccy: 'EUR', status: 'settled', updatedAt: at(8).toISOString(), accountId: 'A1' }],
  });
  const r = evaluate(pmt(), { id: 'bob', role: 'officer' }, w);
  assert.equal(find(r, 'duplicate').status, 'warn');
});

test('missing evidence warns and names the fix', () => {
  const r = evaluate(pmt({ evidence: [] }), { id: 'bob', role: 'officer' }, world());
  assert.equal(find(r, 'evidence').status, 'warn');
  assert.ok(find(r, 'evidence').remedies.some((x) => x.tool === 'attach_evidence'));
});

test('a clean payment approved by a different person clears every control', () => {
  const r = evaluate(pmt(), { id: 'bob', role: 'officer' }, world());
  assert.equal(r.decision, 'allow', JSON.stringify(r.needs, null, 2));
});

test('every rail in the table is internally consistent', () => {
  for (const [id, r] of Object.entries(RAILS)) {
    assert.ok(r.label && r.settles, `${id} needs a label and settlement description`);
    assert.ok(r.cutoff === null || (r.cutoff > 0 && r.cutoff < 1440), `${id} cut-off must be a valid minute of day`);
  }
});
