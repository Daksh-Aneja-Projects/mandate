/**
 * Mandate - the WebMCP surface.
 *
 * The whole tool surface is recomputed from state and re-registered whenever
 * state changes. That is the point of this file: what an agent is *able to do*
 * is a function of who is at the desk, what authority a person has granted, and
 * what the queue currently looks like. Grant a mandate and tools appear. Revoke
 * it and they are gone before the next call.
 *
 * ponytail: full re-registration on every change rather than diffing. ~20 tools,
 * so the cost is nil and there is no stale-registration bug to have. Diff only
 * if the surface ever grows into the hundreds.
 */
import * as S from './state.js';
import { RAILS, ROLES, money } from './controls.js';

let controller = null;
let queued = false;

// ------------------------------------------------------------- helpers ----

/** Result shaped for a reader. Narrative first, because there is no output
 *  schema in WebMCP and the agent reads prose; compact data after, for
 *  precision. */
const ok = (text, data) => ({
  content: [{ type: 'text', text: data === undefined ? text : `${text}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` }],
});

/** A refusal is not an error. It is a governed outcome, and it always names the
 *  way forward, so the agent can act rather than guess or retry blindly. */
const refuse = (why, remedies = [], data) => ok(
  `Refused. ${why}` + (remedies.length
    ? `\n\nWhat you can do instead:\n${remedies.map((r) => `  - ${r.tool}: ${r.why}`).join('\n')}`
    : ''),
  data);

const fault = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Amounts arrive as the user would write them ("4820.00"), never as an agent's
 *  arithmetic. Chrome's own guidance: accept raw input, do not ask the model to
 *  calculate. We do the conversion to minor units here, strictly. */
function toMinor(input) {
  const s = String(input).trim().replace(/[, ]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

const describe = (p) => {
  const b = S.beneficiary(p.beneficiaryId);
  return `${p.id} - ${money(p.amountMinor, p.ccy)} to ${b ? b.name : 'unknown beneficiary'} on ${RAILS[p.rail]?.label || p.rail}, ref ${p.ref || 'none'}, currently ${p.status}`;
};

const controlLines = (r) => r.controls
  .map((c) => `  ${c.status === 'pass' ? '[ok]' : c.status === 'warn' ? '[attention]' : '[blocked]'} ${c.title}: ${c.explain}`)
  .join('\n');

const slim = (p) => ({
  id: p.id, amount: (p.amountMinor / 100).toFixed(2), currency: p.ccy,
  beneficiary: S.beneficiary(p.beneficiaryId)?.name ?? null,
  beneficiaryStatus: S.beneficiary(p.beneficiaryId)?.status ?? null,
  rail: RAILS[p.rail]?.label ?? p.rail, reference: p.ref ?? null,
  status: p.status, createdBy: p.createdBy, account: p.accountId,
  hasEvidence: (p.evidence || []).length > 0,
});

// ------------------------------------------------------------- the tools ----

function buildTools() {
  const ms = S.mandateStatus();
  const meUser = S.me();
  const tools = [];
  const T = (t) => tools.push(t);

  // ============================ read tier ==================================
  // Free rein. An agent should be able to understand a desk completely before
  // it is trusted to touch anything on it.

  T({
    name: 'get_desk_status',
    description: 'Orientation for the whole desk: who is on it, what authority you currently hold as an agent, how the payment queue breaks down, which payments are blocked and why, account balances, and how long until each payment rail closes for the day. Call this first.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const byStatus = {};
      for (const p of S.state.payments) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      const blocked = S.state.payments
        .filter((p) => p.status === 'draft' || p.status === 'held')
        .map((p) => ({ p, r: S.check(p) }))
        .filter((x) => x.r.decision !== 'allow');
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const rails = Object.entries(RAILS).map(([id, r]) => ({
        rail: r.label,
        closes: r.cutoff === null ? 'does not close' : `${String(Math.floor(r.cutoff / 60)).padStart(2, '0')}:${String(r.cutoff % 60).padStart(2, '0')}`,
        minutesLeft: r.cutoff === null ? null : r.cutoff - mins,
      }));

      const text = [
        `${S.state.desk.org} - ${S.state.desk.desk}. This is a demonstration desk: the data is fictional, the controls evaluated against it are real.`,
        `At the desk right now: ${meUser.name} (${ROLES[meUser.role].label}).`,
        ms.active
          ? `You are operating under a mandate ${S.state.users[ms.mandate.grantedBy]?.name} granted: up to ${money(ms.mandate.perPaymentMinor, ms.mandate.ccy)} per payment, ${money(ms.budgetLeftMinor, ms.mandate.ccy)} of budget left, ${Math.round(ms.msLeft / 60000)} minutes before it expires.`
          : `You hold no authority to move money. You can investigate anything here, prepare drafts, and ask a person to decide. To release anything yourself you would need a person to grant you a mandate.`,
        ``,
        `Queue: ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ')}.`,
        `${blocked.length} payment(s) cannot move as they stand:`,
        ...blocked.map((x) => `  ${x.p.id} (${money(x.p.amountMinor, x.p.ccy)}) - ${x.r.needs[0].title}: ${x.r.needs[0].explain}`),
      ].join('\n');

      return ok(text, {
        accounts: S.state.accounts.map((a) => ({ account: a.label, available: (a.availableMinor / 100).toFixed(2), currency: a.ccy })),
        rails,
        mandate: ms.active ? { perPayment: (ms.mandate.perPaymentMinor / 100).toFixed(2), budgetLeft: (ms.budgetLeftMinor / 100).toFixed(2), expiresAt: ms.mandate.expiresAt } : null,
      });
    },
  });

  T({
    name: 'get_authority',
    description: 'Explains exactly what you as an agent are and are not permitted to do on this desk at this moment, and what would have to change for a refused action to become permitted. Call this when something is refused and you want to know why.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ok(
      ms.active
        ? [
          `You are acting under a mandate granted by ${S.state.users[ms.mandate.grantedBy]?.name} at ${new Date(ms.mandate.grantedAt).toLocaleTimeString()}.`,
          `  Per payment ceiling: ${money(ms.mandate.perPaymentMinor, ms.mandate.ccy)}`,
          `  Remaining budget: ${money(ms.budgetLeftMinor, ms.mandate.ccy)} of ${money(ms.mandate.totalMinor, ms.mandate.ccy)}`,
          `  Rails: ${ms.mandate.rails.map((r) => RAILS[r]?.label || r).join(', ')}`,
          `  Beneficiaries: ${ms.mandate.knownBeneficiariesOnly ? 'already verified on file only' : 'any beneficiary'}`,
          `  Expires: ${new Date(ms.mandate.expiresAt).toLocaleTimeString()} (${Math.round(ms.msLeft / 60000)} minutes)`,
          ``,
          `Outside those bounds you have no authority, and the desk will route the payment to a person instead. ${S.state.users[ms.mandate.grantedBy]?.name} can revoke this at any moment, and the tools available to you will change immediately when they do.`,
        ].join('\n')
        : [
          `You hold no standing authority on this desk.`,
          ``,
          `You can: read anything, prepare drafts, attach evidence, and ask a person to decide.`,
          `You cannot: approve, release, or override a hold on your own account. An agent is never a second pair of eyes, so a payment can never be both prepared and approved without a person involved.`,
          ``,
          `Two routes forward: request_authorization sends one payment to a named person, or propose_mandate asks a person for bounded, expiring authority to act on a class of payments yourself.`,
        ].join('\n')),
  });

  T({
    name: 'search_payments',
    description: 'Search the payment queue. Filter by status, rail, beneficiary name, reference, minimum or maximum amount, or restrict to only those payments that currently cannot move. Returns a summary of each match.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'held', 'authorized', 'released', 'settled', 'any'], description: 'Payment status to filter on. Use "any" for no status filter.' },
        rail: { type: 'string', enum: [...Object.keys(RAILS), 'any'], description: 'Payment rail to filter on.' },
        beneficiary: { type: 'string', description: 'Case-insensitive substring of the beneficiary name.' },
        reference: { type: 'string', description: 'Case-insensitive substring of the payment reference.' },
        minAmount: { type: 'string', description: 'Minimum amount as written, for example "1000.00". Do not convert to cents.' },
        maxAmount: { type: 'string', description: 'Maximum amount as written, for example "5000.00". Do not convert to cents.' },
        onlyBlocked: { type: 'boolean', description: 'If true, return only payments that cannot move as they stand.' },
      },
    },
    execute: async (a = {}) => {
      const min = a.minAmount ? toMinor(a.minAmount) : null;
      const max = a.maxAmount ? toMinor(a.maxAmount) : null;
      if (a.minAmount && min === null) return fault(`"${a.minAmount}" is not an amount I can read. Write it as digits with up to two decimal places, for example "1000.00".`);
      if (a.maxAmount && max === null) return fault(`"${a.maxAmount}" is not an amount I can read. Write it as digits with up to two decimal places, for example "5000.00".`);

      let rows = S.state.payments.filter((p) => {
        if (a.status && a.status !== 'any' && p.status !== a.status) return false;
        if (a.rail && a.rail !== 'any' && p.rail !== a.rail) return false;
        if (min !== null && p.amountMinor < min) return false;
        if (max !== null && p.amountMinor > max) return false;
        if (a.reference && !(p.ref || '').toLowerCase().includes(a.reference.toLowerCase())) return false;
        if (a.beneficiary) {
          const b = S.beneficiary(p.beneficiaryId);
          if (!b || !b.name.toLowerCase().includes(a.beneficiary.toLowerCase())) return false;
        }
        return true;
      });
      if (a.onlyBlocked) rows = rows.filter((p) => S.check(p).decision !== 'allow');

      if (!rows.length) return ok('No payments match that.');
      return ok(
        `${rows.length} payment(s):\n${rows.map((p) => `  ${describe(p)}`).join('\n')}`,
        rows.map(slim));
    },
  });

  T({
    name: 'get_payment',
    description: 'Full detail on one payment, including every control the desk evaluates against it and the plain-English result of each. Use this before asking anyone to approve anything.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Payment id, for example "PMT-2041".' } },
      required: ['id'],
    },
    execute: async ({ id }) => {
      const p = S.payment(id);
      if (!p) return fault(`There is no payment ${id} on this desk. Use search_payments to find the right one.`);
      const r = S.check(p);
      const b = S.beneficiary(p.beneficiaryId);
      const acct = S.account(p.accountId);
      return ok([
        describe(p) + '.',
        `Debiting ${acct ? acct.label : 'an unknown account'}. Created by ${S.state.users[p.createdBy]?.name || p.createdBy} at ${new Date(p.createdAt).toLocaleTimeString()}.`,
        b ? `Beneficiary ${b.name} (${b.country}), ${b.status}, screening ${b.screening}, ${b.priorPayments} prior payment(s).` : 'Beneficiary is not on file.',
        (p.evidence || []).length ? `Evidence: ${p.evidence.map((e) => e.label).join('; ')}.` : 'No supporting evidence is attached.',
        ``,
        `Controls, evaluated for you as the agent right now:`,
        controlLines(r),
        ``,
        r.decision === 'allow'
          ? 'Every control passes. You may release this.'
          : r.decision === 'blocked'
            ? 'This cannot move as it stands.'
            : 'This needs a person to look at it before it moves.',
      ].join('\n'), { ...slim(p), decision: r.decision });
    },
  });

  T({
    name: 'explain_hold',
    description: 'Explain in plain language why a specific payment cannot move, and list the concrete routes forward. Use this to give a person a straight answer instead of a status code.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Payment id, for example "PMT-2048".' } },
      required: ['id'],
    },
    execute: async ({ id }) => {
      const p = S.payment(id);
      if (!p) return fault(`There is no payment ${id} on this desk.`);
      const r = S.check(p);
      if (r.decision === 'allow') return ok(`${id} is not held. Every control passes for it.`);
      const remedies = r.needs.flatMap((c) => c.remedies);
      return ok([
        `${id} - ${money(p.amountMinor, p.ccy)} to ${S.beneficiary(p.beneficiaryId)?.name || 'an unknown beneficiary'}.`,
        ``,
        ...r.needs.map((c) => `${c.status === 'block' ? 'Blocked' : 'Needs attention'} - ${c.title}\n  ${c.explain}`),
        remedies.length ? `\nRoutes forward:\n${remedies.map((x) => `  - ${x.tool}: ${x.why}`).join('\n')}` : '',
      ].join('\n'));
    },
  });

  T({
    name: 'search_beneficiaries',
    description: 'Search the beneficiary register by name or country, with verification status, screening status and payment history for each.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring of the beneficiary name or two-letter country code.' },
        status: { type: 'string', enum: ['verified', 'unverified', 'any'], description: 'Verification status filter.' },
      },
    },
    execute: async (a = {}) => {
      const rows = S.state.beneficiaries.filter((b) => {
        if (a.status && a.status !== 'any' && b.status !== a.status) return false;
        if (a.query) {
          const q = a.query.toLowerCase();
          if (!b.name.toLowerCase().includes(q) && b.country.toLowerCase() !== q) return false;
        }
        return true;
      });
      if (!rows.length) return ok('No beneficiaries match that.');
      return ok(rows.map((b) =>
        `  ${b.name} (${b.country}) - ${b.status}${b.screening === 'match' ? ', SCREENING MATCH: ' + b.screeningNote : ''}, ${b.priorPayments} prior payment(s)${b.status === 'verified' ? `, verified ${b.verifiedOn}` : `, added ${b.addedDaysAgo} day(s) ago and not yet verified`}`).join('\n'),
        rows.map((b) => ({ id: b.id, name: b.name, country: b.country, status: b.status, screening: b.screening, priorPayments: b.priorPayments })));
    },
  });

  T({
    name: 'get_exposure',
    description: 'Cash position per account: what is available, what the queue has already pledged against it, and what is genuinely free to spend. Use this before promising anyone that a payment can be funded.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const rows = S.state.accounts.map((a) => {
        const pledged = S.state.payments
          .filter((p) => p.accountId === a.id && ['authorized', 'released'].includes(p.status))
          .reduce((s, p) => s + p.amountMinor, 0);
        const queued = S.state.payments
          .filter((p) => p.accountId === a.id && p.status === 'draft')
          .reduce((s, p) => s + p.amountMinor, 0);
        return { a, pledged, queued, free: a.availableMinor - pledged };
      });
      return ok(rows.map(({ a, pledged, queued, free }) =>
        `  ${a.label}: ${money(a.availableMinor, a.ccy)} available, ${money(pledged, a.ccy)} already pledged, ${money(free, a.ccy)} genuinely free. A further ${money(queued, a.ccy)} sits in drafts not yet approved.`).join('\n'),
        rows.map(({ a, pledged, queued, free }) => ({ account: a.label, currency: a.ccy, available: (a.availableMinor / 100).toFixed(2), pledged: (pledged / 100).toFixed(2), free: (free / 100).toFixed(2), inDrafts: (queued / 100).toFixed(2) })));
    },
  });

  T({
    name: 'get_audit_trail',
    description: 'The desk audit trail in plain English: every action taken by a person or an agent, in order, with who did it and when. Nothing an agent does on this desk is unlogged.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many of the most recent entries to return. Defaults to 20.' } },
    },
    execute: async ({ limit = 20 } = {}) => ok(
      S.state.audit.slice(0, Math.max(1, Math.min(100, limit)))
        .map((e) => `  ${new Date(e.at).toLocaleTimeString()} - ${e.text}`).join('\n') || 'The audit trail is empty.'),
  });

  // ========================== prepare tier =================================
  // Mutates drafts. Moves no money. An agent is genuinely useful here without
  // ever needing to be trusted.

  T({
    name: 'draft_payment',
    description: 'Prepare a new payment as a draft. This moves no money: it creates something a person or a mandate can later release. The draft appears on the desk screen immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Account to debit, for example "ACC-EUR-01". Use get_exposure to list them.' },
        beneficiaryId: { type: 'string', description: 'Beneficiary id from search_beneficiaries, for example "BEN-01".' },
        amount: { type: 'string', description: 'Amount as written, for example "4820.00". Do not convert to cents.' },
        currency: { type: 'string', enum: ['EUR', 'GBP', 'USD'], description: 'Currency of the payment.' },
        rail: { type: 'string', enum: Object.keys(RAILS), description: 'Payment rail to send it on.' },
        reference: { type: 'string', description: 'Payment reference, usually an invoice number.' },
      },
      required: ['accountId', 'beneficiaryId', 'amount', 'currency', 'rail'],
    },
    execute: async (a) => {
      const minor = toMinor(a.amount);
      if (minor === null) return fault(`"${a.amount}" is not an amount I can read. Write it as digits with up to two decimal places, for example "4820.00".`);
      if (minor === 0) return fault('A payment of zero is not something this desk can send.');
      if (!S.account(a.accountId)) return fault(`There is no account ${a.accountId}. Call get_exposure to see the accounts on this desk.`);
      if (!S.beneficiary(a.beneficiaryId)) return fault(`There is no beneficiary ${a.beneficiaryId}. Call search_beneficiaries to find the right one.`);

      const p = S.draftPayment({
        accountId: a.accountId, beneficiaryId: a.beneficiaryId, amountMinor: minor,
        ccy: a.currency, rail: a.rail, ref: a.reference || null,
      });
      const r = S.check(p);
      return ok([
        `Drafted ${p.id}: ${describe(p)}. Nothing has moved.`,
        ``,
        `Controls as it stands:`,
        controlLines(r),
      ].join('\n'), slim(p));
    },
  });

  T({
    name: 'amend_payment',
    description: 'Change a draft payment: its amount, rail, reference or beneficiary. Only drafts can be amended; anything already approved or released cannot be edited.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Payment id to amend.' },
        amount: { type: 'string', description: 'New amount as written, for example "4820.00".' },
        rail: { type: 'string', enum: Object.keys(RAILS), description: 'New rail.' },
        reference: { type: 'string', description: 'New payment reference.' },
        beneficiaryId: { type: 'string', description: 'New beneficiary id.' },
      },
      required: ['id'],
    },
    execute: async (a) => {
      const p = S.payment(a.id);
      if (!p) return fault(`There is no payment ${a.id} on this desk.`);
      if (p.status !== 'draft') return refuse(
        `${a.id} is ${p.status}, and only drafts can be amended. Changing a payment after it has been approved would invalidate the approval it was given under.`,
        p.status === 'released' || p.status === 'settled' ? [{ tool: 'draft_payment', why: 'Prepare a corrective payment instead.' }] : []);

      const patch = {};
      if (a.amount !== undefined) {
        const m = toMinor(a.amount);
        if (m === null) return fault(`"${a.amount}" is not an amount I can read.`);
        patch.amountMinor = m;
      }
      if (a.rail) patch.rail = a.rail;
      if (a.reference !== undefined) patch.ref = a.reference;
      if (a.beneficiaryId) {
        if (!S.beneficiary(a.beneficiaryId)) return fault(`There is no beneficiary ${a.beneficiaryId}.`);
        patch.beneficiaryId = a.beneficiaryId;
      }
      if (!Object.keys(patch).length) return fault('Nothing to change. Give at least one of amount, rail, reference or beneficiaryId.');

      S.amendPayment(a.id, patch);
      const r = S.check(S.payment(a.id));
      return ok(`Amended ${a.id}. Now: ${describe(S.payment(a.id))}.\n\nControls:\n${controlLines(r)}`, slim(S.payment(a.id)));
    },
  });

  T({
    name: 'attach_evidence',
    description: 'Attach supporting evidence to a payment - an invoice, contract clause or written instruction that explains why the money is owed. Audit expects every payment to carry this.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Payment id.' },
        label: { type: 'string', description: 'What the evidence is, for example "Invoice INV-CS-20551" or "Supply agreement SA-2024-11 clause 7".' },
        kind: { type: 'string', enum: ['invoice', 'contract', 'po', 'instruction'], description: 'Type of evidence.' },
      },
      required: ['id', 'label', 'kind'],
    },
    execute: async ({ id, label, kind }) => {
      const p = S.payment(id);
      if (!p) return fault(`There is no payment ${id} on this desk.`);
      S.amendPayment(id, { evidence: [...(p.evidence || []), { label, kind }] });
      return ok(`Attached "${label}" to ${id}. It now carries ${S.payment(id).evidence.length} piece(s) of evidence.`);
    },
  });

  // ======================= consequential tier ==============================
  // These hold the agent's call open while a person decides. The human is
  // inside the tool call, not notified after it.

  T({
    name: 'request_authorization',
    description: 'Ask a named person at the desk to authorise a payment. This does not return until they decide, so you will get their actual answer, not an acknowledgement. Use this for anything you have no authority to do yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Payment id to route for authorisation.' },
        note: { type: 'string', description: 'What you want them to know: why this is owed, what you checked, and anything that needs their judgement. Write it for a person, not a log.' },
      },
      required: ['id', 'note'],
    },
    execute: async ({ id, note }, { signal } = {}) => {
      const p = S.payment(id);
      if (!p) return fault(`There is no payment ${id} on this desk.`);
      if (['released', 'settled'].includes(p.status)) return refuse(`${id} has already been ${p.status}. There is nothing left to authorise.`);

      const r = S.check(p, { id: S.state.me, role: S.me().role }, 'authorize');
      const hard = r.controls.filter((c) => c.status === 'block' && ['screening', 'funding', 'rail'].includes(c.id));
      if (hard.length) return refuse(
        `${hard[0].explain} Asking a person to approve this would be asking them to approve something the desk cannot execute.`,
        hard[0].remedies, { blockedBy: hard[0].title });

      const decision = await S.askHuman({
        kind: 'authorize', payment: p, controls: r, note,
        title: `Authorise ${p.id}`,
        body: `${money(p.amountMinor, p.ccy)} to ${S.beneficiary(p.beneficiaryId)?.name}`,
      }, signal);

      if (!decision.ok) return ok(`${decision.text} ${id} is untouched and still ${S.payment(id).status}.`);
      S.recordApproval(id, decision.by, p.amountMinor);
      S.releasePayment(id, decision.by, decision.note ? `Note: ${decision.note}` : '');
      return ok([
        `${S.state.users[decision.by]?.name} authorised ${id} and it has been released.`,
        `${money(p.amountMinor, p.ccy)} to ${S.beneficiary(p.beneficiaryId)?.name} on ${RAILS[p.rail]?.label}, settling in ${RAILS[p.rail]?.settles}.`,
        decision.note ? `They added: "${decision.note}"` : '',
      ].filter(Boolean).join('\n'));
    },
  });

  T({
    name: 'release_payment',
    description: 'Release a payment so it actually goes out. You can only do this on your own if a person has granted you a mandate that covers it; otherwise this refuses and tells you the route that would work.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Payment id to release.' } },
      required: ['id'],
    },
    execute: async ({ id }) => {
      const p = S.payment(id);
      if (!p) return fault(`There is no payment ${id} on this desk.`);
      if (['released', 'settled'].includes(p.status)) return refuse(`${id} is already ${p.status}.`);
      const r = S.check(p);
      if (r.decision !== 'allow') {
        const c = r.needs[0];
        return refuse(`${c.title}. ${c.explain}`, c.remedies, { payment: id, decision: r.decision });
      }
      S.releasePayment(id, 'agent', 'Released by the agent under mandate.');
      const left = S.mandateStatus();
      return ok([
        `Released ${id}: ${money(p.amountMinor, p.ccy)} to ${S.beneficiary(p.beneficiaryId)?.name} on ${RAILS[p.rail]?.label}.`,
        left.active ? `${money(left.budgetLeftMinor, left.mandate.ccy)} of mandate budget remains, expiring at ${new Date(left.mandate.expiresAt).toLocaleTimeString()}.` : '',
        `${S.state.users[S.state.me]?.name} can reverse this from the desk.`,
      ].filter(Boolean).join('\n'));
    },
  });

  // ========================== governance tier ==============================
  // The part that does not exist in any other agent integration: the agent
  // negotiating the authority it operates under, with a person holding the pen.

  T({
    name: 'propose_mandate',
    description: 'Ask a person for bounded, expiring authority to release payments yourself, so you stop having to interrupt them for every routine one. You propose the scope; they can tighten any part of it before granting, or refuse. This does not return until they decide. If granted, new tools become available to you immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        perPayment: { type: 'string', description: 'The most you are asking to be able to release in a single payment, as written, for example "5000.00".' },
        total: { type: 'string', description: 'The total you are asking to be able to release across all payments under this mandate, for example "50000.00".' },
        currency: { type: 'string', enum: ['EUR', 'GBP', 'USD'], description: 'Currency the limits are expressed in.' },
        minutes: { type: 'number', description: 'How long you are asking the authority to last, in minutes. Keep it short; ask again if you need longer.' },
        rails: { type: 'array', items: { type: 'string', enum: Object.keys(RAILS) }, description: 'The rails you are asking to cover.' },
        knownBeneficiariesOnly: { type: 'boolean', description: 'Whether to limit the mandate to beneficiaries already verified on file. Asking for true makes a person far more likely to agree.' },
        reason: { type: 'string', description: 'Why you are asking, in plain language: what you intend to do with it and what it saves the person. They read this before deciding.' },
      },
      required: ['perPayment', 'total', 'currency', 'minutes', 'reason'],
    },
    execute: async (a, { signal } = {}) => {
      const per = toMinor(a.perPayment), total = toMinor(a.total);
      if (per === null || total === null) return fault('Write the limits as digits with up to two decimal places, for example "5000.00".');
      if (per > total) return fault(`A per-payment ceiling of ${money(per, a.currency)} above a total budget of ${money(total, a.currency)} does not make sense. The total has to be at least the per-payment ceiling.`);
      if (!(a.minutes > 0)) return fault('Ask for a positive number of minutes.');
      if (ms.active) return refuse(
        `A mandate is already in force until ${new Date(ms.mandate.expiresAt).toLocaleTimeString()}, with ${money(ms.budgetLeftMinor, ms.mandate.ccy)} left. Work within it, or hand it back before asking for a different one.`,
        [{ tool: 'get_authority', why: 'See exactly what the current mandate covers.' },
         { tool: 'revoke_mandate', why: 'Hand back the current mandate first.' }]);

      const granter = S.me();
      if (!ROLES[granter.role].canGrantMandate) return refuse(
        `${granter.name} is a ${ROLES[granter.role].label} and cannot grant release authority on this desk. Only a Payments Officer or Treasury Controller can.`,
        [{ tool: 'request_authorization', why: 'Route individual payments instead.' }]);

      const proposal = {
        perPaymentMinor: per, totalMinor: total, ccy: a.currency,
        minutes: Math.round(a.minutes), rails: a.rails?.length ? a.rails : Object.keys(RAILS),
        knownBeneficiariesOnly: a.knownBeneficiariesOnly !== false,
        reason: a.reason,
      };

      const decision = await S.askHuman({
        kind: 'mandate', proposal, title: 'Grant a mandate', ttlMs: 300000,
        body: `The agent is asking for release authority`,
      }, signal);

      if (!decision.ok) return ok(`${decision.text} You still hold no authority to release anything.`);

      const g = decision.granted;
      const changed = [];
      if (g.perPaymentMinor !== per) changed.push(`the per-payment ceiling to ${money(g.perPaymentMinor, g.ccy)}`);
      if (g.totalMinor !== total) changed.push(`the total budget to ${money(g.totalMinor, g.ccy)}`);
      if (g.minutes !== proposal.minutes) changed.push(`the duration to ${g.minutes} minutes`);

      return ok([
        `${S.state.users[g.grantedBy]?.name} granted the mandate${changed.length ? `, having tightened ${changed.join(' and ')}` : ' exactly as you asked'}.`,
        ``,
        `You may now release payments up to ${money(g.perPaymentMinor, g.ccy)} each, ${money(g.totalMinor, g.ccy)} in total, on ${g.rails.map((r) => RAILS[r]?.label || r).join(' and ')}${g.knownBeneficiariesOnly ? ', to beneficiaries already verified on file' : ''}, until ${new Date(g.expiresAt).toLocaleTimeString()}.`,
        `Anything outside that still goes to a person.`,
        ``,
        `A new tool, release_under_mandate, is now available to you for clearing eligible payments in one pass. ${S.state.users[g.grantedBy]?.name} can revoke this at any moment.`,
      ].join('\n'));
    },
  });

  T({
    name: 'get_mandate',
    description: 'The standing mandate in force right now, if any: its limits, how much of its budget is left, and when it expires.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ms.active
      ? ok(`Granted by ${S.state.users[ms.mandate.grantedBy]?.name} at ${new Date(ms.mandate.grantedAt).toLocaleTimeString()}. Up to ${money(ms.mandate.perPaymentMinor, ms.mandate.ccy)} per payment. ${money(ms.budgetLeftMinor, ms.mandate.ccy)} of ${money(ms.mandate.totalMinor, ms.mandate.ccy)} left. Expires ${new Date(ms.mandate.expiresAt).toLocaleTimeString()}, in ${Math.round(ms.msLeft / 60000)} minute(s). Reason given: ${ms.mandate.reason}`)
      : ok(`No mandate is in force. ${ms.reason}`),
  });

  T({
    name: 'undo_last_agent_action',
    description: 'Ask a person to reverse the last thing you did. Use this the moment you realise you have made a mistake, rather than trying to correct it with another payment.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why it should be reversed, in plain language.' } },
      required: ['reason'],
    },
    execute: async ({ reason }, { signal } = {}) => {
      const top = S.state.undoStack[0];
      if (!top) return ok('There is nothing of yours left to reverse.');
      const decision = await S.askHuman({
        kind: 'undo', title: 'Reverse the last action', body: top.label, note: reason,
      }, signal);
      if (!decision.ok) return ok(`${decision.text} Nothing was reversed.`);
      S.undoLast();
      return ok(`${S.state.users[decision.by]?.name} reversed it: ${top.label}.`);
    },
  });

  // ==================== only while a mandate is live =======================
  // These do not exist as tools until a person grants authority, and they stop
  // existing the moment it is revoked or expires. The agent's own tool list
  // changes underneath it - that is what a mandate physically is here.

  if (ms.active) {
    T({
      name: 'release_under_mandate',
      description: 'Release every payment that falls inside the mandate you currently hold, in one pass. Anything outside the mandate is left alone and reported back to you with the reason, so you can route those to a person.',
      inputSchema: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: 'If true, report what would be released without releasing anything. Worth doing first.' },
          maxPayments: { type: 'number', description: 'Optional ceiling on how many to release in this pass.' },
        },
      },
      execute: async ({ dryRun = false, maxPayments } = {}) => {
        // Everything still outstanding, not just drafts. A payment sitting on a
        // hold has to be reported back too, or the sweep quietly hides it.
        const candidates = S.state.payments.filter((p) => !['released', 'settled'].includes(p.status));
        const eligible = [], skipped = [];
        let running = 0;
        for (const p of candidates) {
          const r = S.check(p);
          if (r.decision === 'allow' && running + p.amountMinor <= S.mandateStatus().budgetLeftMinor) {
            if (maxPayments && eligible.length >= maxPayments) { skipped.push({ p, why: `not reached: this pass was capped at ${maxPayments} payment(s)` }); continue; }
            eligible.push(p); running += p.amountMinor;
          } else {
            skipped.push({ p, why: r.decision === 'allow' ? 'would exceed the remaining mandate budget' : `${r.needs[0].title.toLowerCase()} - ${r.needs[0].explain}` });
          }
        }

        if (!eligible.length) return ok([
          `Nothing in the queue falls inside your mandate.`,
          ...skipped.map((s) => `  ${s.p.id} (${money(s.p.amountMinor, s.p.ccy)}) - ${s.why}`),
        ].join('\n'));

        const head = `${dryRun ? 'Would release' : 'Released'} ${eligible.length} payment(s) totalling ${money(running, ms.mandate.ccy)}:\n${eligible.map((p) => `  ${describe(p)}`).join('\n')}`;
        const tail = skipped.length
          ? `\n\nLeft for a person (${skipped.length}):\n${skipped.map((s) => `  ${s.p.id} (${money(s.p.amountMinor, s.p.ccy)}) - ${s.why}`).join('\n')}`
          : '';

        if (dryRun) return ok(`${head}${tail}\n\nNothing has moved. Call this again without dryRun to release them.`);
        for (const p of eligible) S.releasePayment(p.id, 'agent', 'Released under mandate.');
        const left = S.mandateStatus();
        return ok(`${head}${tail}\n\n${left.active ? `${money(left.budgetLeftMinor, left.mandate.ccy)} of mandate budget remains.` : 'The mandate is now exhausted or expired.'} ${S.state.users[S.state.me]?.name} can reverse any of these from the desk.`);
      },
    });

    T({
      name: 'revoke_mandate',
      description: 'Hand back the mandate you hold before it expires, when you no longer need it. Good practice once you have finished the work you asked for it.',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why you are handing it back.' } },
        required: ['reason'],
      },
      execute: async ({ reason }) => {
        const m = S.revokeMandate('agent');
        return ok(`Mandate handed back. ${reason}\nYou released ${money(m.spentMinor || 0, m.ccy)} under it. You now hold no authority to move money, and release_under_mandate is no longer available to you.`);
      },
    });
  }

  return tools;
}

// ------------------------------------------------------- registration ----

/** Recompute and re-register the entire tool surface from current state. */
export async function syncTools() {
  if (!('modelContext' in document)) return { supported: false, count: 0 };
  controller?.abort();
  controller = new AbortController();

  const tools = buildTools();
  for (const t of tools) {
    const inner = t.execute;
    // Wrap every tool so the desk screen shows the call as it happens and the
    // audit trail records it, whatever the tool is.
    t.execute = async (input, ctx) => {
      S.trace(t.name, input, 'running');
      try {
        const res = await inner(input, ctx || {});
        S.trace(t.name, input, res?.isError ? 'error' : 'done');
        return res;
      } catch (e) {
        S.trace(t.name, input, 'error');
        return fault(`Something went wrong inside ${t.name} and nothing was changed: ${e.message}`);
      }
    };
    await document.modelContext.registerTool(t, { signal: controller.signal });
  }
  return { supported: true, count: tools.length, names: tools.map((t) => t.name) };
}

/** Coalesce bursts of state changes into one re-registration. */
export function scheduleSync() {
  if (queued) return;
  queued = true;
  queueMicrotask(async () => { queued = false; await syncTools(); });
}

export const toolNames = () => buildTools().map((t) => ({ name: t.name, readOnly: !!t.annotations?.readOnlyHint }));
