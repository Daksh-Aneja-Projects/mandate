/**
 * Mandate - state, audit and undo.
 *
 * Everything lives in this tab. No server, no telemetry, no third party. The
 * desk's data never leaves the browser, which is the whole reason a page can be
 * trusted to be the authority boundary in the first place.
 */
import { DESK, USERS, ACCOUNTS, BENEFICIARIES, PAYMENTS, AUDIT_SEED } from './seed.js';
import { evaluate, mandateCovers, money, RAILS, ROLES } from './controls.js';

const listeners = new Set();

export const state = {
  desk: DESK,
  users: USERS,
  me: 'p.raghavan',            // the human at the desk; switchable in the UI
  accounts: structuredClone(ACCOUNTS),
  beneficiaries: structuredClone(BENEFICIARIES),
  payments: structuredClone(PAYMENTS),
  approvals: {},               // paymentId -> [{ by, at, amountMinor }]
  audit: structuredClone(AUDIT_SEED),
  mandate: null,               // the standing grant of authority, or null
  mandateHistory: [],
  pending: [],                 // requests waiting on a human, holding a tool call open
  agentTrace: [],              // every tool call an agent has made, live
  undoStack: [],               // agent actions a human can reverse
  agentConnected: false,
  lastToolAt: null,
};

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = () => { for (const fn of listeners) fn(state); };

/**
 * The desk clock. A payment desk is only interesting while the rails are still
 * open, so the demonstration desk opens at 09:15 and runs forward in real time
 * from there. The header shows this clock so nobody mistakes it for the wall
 * clock, and every control that cares about time reads it rather than Date.now.
 */
const DESK_OPENS = 9 * 60 + 15;
const deskOffsetMs = (() => {
  const real = new Date();
  const target = new Date(real);
  target.setHours(Math.floor(DESK_OPENS / 60), DESK_OPENS % 60, 0, 0);
  return target - real;
})();
export const deskNow = () => new Date(Date.now() + deskOffsetMs);

export const me = () => state.users[state.me];
/** The identity of whoever is at the desk, for evaluating the desk's own view. */
export const deskActor = () => ({ id: state.me, role: me().role });

export const world = () => ({
  beneficiaries: state.beneficiaries,
  accounts: state.accounts,
  payments: state.payments,
  approvals: state.approvals,
  mandate: state.mandate,
  now: deskNow(),
  nameOf: (id) => (id === 'agent' ? 'the agent' : state.users[id]?.name ?? id),
});

export const payment = (id) => state.payments.find((p) => p.id === id);
export const beneficiary = (id) => state.beneficiaries.find((b) => b.id === id);
export const account = (id) => state.accounts.find((a) => a.id === id);
export const check = (p, actor = { id: 'agent', role: 'agent' }, intent = 'authorize') =>
  evaluate(p, actor, world(), intent);

// ---------------------------------------------------------------- audit ----
/** Audit lines are written for people. No codes, no enums, no stack traces. */
export function log(kind, text, actor = 'agent') {
  state.audit.unshift({ at: new Date().toISOString(), actor, kind, text });
  emit();
}

export function trace(tool, input, outcome) {
  state.agentTrace.unshift({ at: new Date().toISOString(), tool, input, outcome });
  state.agentTrace.length = Math.min(state.agentTrace.length, 60);
  state.lastToolAt = Date.now();
  state.agentConnected = true;
  emit();
}

// ----------------------------------------------------------------- undo ----
/** Agent actions are recorded with the inverse operation, so a person can
 *  always take one back. Undo is human-only by design. */
function undoable(label, apply, revert) {
  apply();
  state.undoStack.unshift({ id: `U${Date.now()}${state.undoStack.length}`, label, revert, at: new Date().toISOString() });
  state.undoStack.length = Math.min(state.undoStack.length, 25);
}

export function undoLast() {
  const u = state.undoStack.shift();
  if (!u) return null;
  u.revert();
  log('undo', `${me().name} reversed: ${u.label}`, state.me);
  return u;
}

// ------------------------------------------------------------- mutation ----
let seq = 2100;
export const nextId = () => `PMT-${++seq}`;

export function draftPayment(fields, by = 'agent') {
  const p = {
    id: nextId(), status: 'draft', createdBy: by,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    evidence: [], ...fields,
  };
  undoable(`drafted ${p.id} for ${money(p.amountMinor, p.ccy)}`,
    () => { state.payments.unshift(p); p.fresh = true; },
    () => { state.payments = state.payments.filter((x) => x.id !== p.id); });
  log('draft', `${by === 'agent' ? 'The agent' : state.users[by]?.name || by} drafted ${p.id} for ${money(p.amountMinor, p.ccy)} to ${beneficiary(p.beneficiaryId)?.name || 'an unknown beneficiary'}.`, by);
  emit();
  return p;
}

export function amendPayment(id, patch, by = 'agent') {
  const p = payment(id);
  if (!p) return null;
  const before = structuredClone(p);
  undoable(`amended ${id}`,
    () => { Object.assign(p, patch, { updatedAt: new Date().toISOString() }); },
    () => { Object.assign(p, before); });
  log('amend', `${by === 'agent' ? 'The agent' : state.users[by]?.name || by} amended ${id}: ${Object.entries(patch).map(([k, v]) => `${k} set to ${v}`).join(', ')}.`, by);
  emit();
  return p;
}

export function recordApproval(id, by, amountMinor) {
  (state.approvals[id] ||= []).push({ by, at: new Date().toISOString(), amountMinor });
}

export function releasePayment(id, by, note) {
  const p = payment(id);
  if (!p) return null;
  const before = { status: p.status, updatedAt: p.updatedAt };
  const rail = RAILS[p.rail];
  undoable(`released ${id} for ${money(p.amountMinor, p.ccy)}`,
    () => { p.status = 'released'; p.updatedAt = new Date().toISOString(); p.releasedBy = by; p.justReleased = true; },
    () => { Object.assign(p, before); p.releasedBy = null; });
  if (state.mandate && by === 'agent') state.mandate.spentMinor = (state.mandate.spentMinor || 0) + p.amountMinor;
  log('release', `${by === 'agent' ? 'The agent' : state.users[by]?.name || by} released ${id} for ${money(p.amountMinor, p.ccy)} to ${beneficiary(p.beneficiaryId)?.name} on ${rail?.label || p.rail}, settling in ${rail?.settles || 'an unknown time'}.${note ? ` ${note}` : ''}`, by);
  emit();
  return p;
}

// -------------------------------------------------------------- mandate ----
export function grantMandate(m) {
  state.mandate = { ...m, grantedAt: new Date().toISOString(), spentMinor: 0, revokedAt: null };
  state.mandateHistory.unshift(state.mandate);
  log('mandate', `${state.users[m.grantedBy]?.name || m.grantedBy} granted the agent authority to release up to ${money(m.perPaymentMinor, m.ccy)} per payment, ${money(m.totalMinor, m.ccy)} in total, on ${m.rails.map((r) => RAILS[r]?.label || r).join(' and ')}${m.knownBeneficiariesOnly ? ', to verified beneficiaries only' : ''}, expiring at ${new Date(m.expiresAt).toLocaleTimeString()}.`, m.grantedBy);
  emit();
  return state.mandate;
}

export function revokeMandate(by) {
  if (!state.mandate || state.mandate.revokedAt) return null;
  state.mandate.revokedAt = new Date().toISOString();
  const spent = state.mandate.spentMinor || 0;
  log('mandate', `${by === 'agent' ? 'The agent handed back' : `${state.users[by]?.name || by} revoked`} the mandate. ${money(spent, state.mandate.ccy)} had been released under it.`, by);
  const m = state.mandate;
  state.mandate = null;
  emit();
  return m;
}

export const mandateStatus = () => {
  const m = state.mandate;
  if (!m) return { active: false, reason: 'No mandate is in force. The agent has no authority to release anything.' };
  if (m.revokedAt) return { active: false, reason: 'The mandate was revoked.' };
  const left = new Date(m.expiresAt) - new Date();
  if (left <= 0) return { active: false, reason: 'The mandate has expired.' };
  return {
    active: true, mandate: m, msLeft: left,
    budgetLeftMinor: m.totalMinor - (m.spentMinor || 0),
  };
};

// ------------------------------------------------- human-in-the-loop ----
/**
 * Open a request that a person has to decide, and hand back a promise that does
 * not settle until they do. The agent's tool call stays open across the wait,
 * which is the entire point: the human is inside the call, not after it.
 *
 * @param {object} req  { kind, title, body, payment, controls, scope, ttlMs }
 */
export function askHuman(req, signal) {
  return new Promise((resolve) => {
    const id = `REQ-${Date.now()}${state.pending.length}`;
    const ttl = req.ttlMs ?? 180000;
    const entry = {
      ...req, id, at: Date.now(), expiresAt: Date.now() + ttl,
      resolve: (decision) => {
        if (!state.pending.find((x) => x.id === id)) return;
        state.pending = state.pending.filter((x) => x.id !== id);
        clearTimeout(timer);
        emit();
        resolve(decision);
      },
    };
    const timer = setTimeout(() => entry.resolve({
      ok: false, reason: 'timeout',
      text: `Nobody at the desk responded within ${Math.round(ttl / 1000)} seconds, so nothing was done. The request has been withdrawn.`,
    }), ttl);

    if (signal) signal.addEventListener('abort', () => entry.resolve({
      ok: false, reason: 'cancelled',
      text: 'The agent withdrew this request before a person decided on it, so nothing was done.',
    }), { once: true });

    state.pending.push(entry);
    emit();
  });
}

export { money, RAILS, ROLES, mandateCovers, evaluate };
