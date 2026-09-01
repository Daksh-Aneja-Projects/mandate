/**
 * Mandate - the desk screen.
 *
 * Two rules run through this file. Nothing is shown as a code or an enum when a
 * sentence would do, and nothing is shown as a number the desk cannot actually
 * account for. Where something is genuinely unavailable it says so rather than
 * rendering an empty box that reads as data.
 */
import * as S from './state.js';
import { RAILS, ROLES, money } from './controls.js';
import { icon, iconEl } from './icons.js';
import { syncTools, scheduleSync, toolNames } from './tools.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The desk screen shows the desk's own view: what the person sitting here can
 * and cannot do. The agent's view of the same payment is a different question,
 * and it is answered in the Authority panel and in the tools themselves.
 */
const deskCheck = (p) => S.check(p, S.deskActor(), 'authorize');

let view = 'queue';
let filter = 'all';
let litPayment = null;
let knownTools = new Set();
let dockKey = '';

// ------------------------------------------------------------- boot ----
$('mark').innerHTML = icon.mark;
$('deskName').textContent = `${S.state.desk.org} - ${S.state.desk.desk}`;

$('whoSelect').innerHTML = Object.values(S.state.users)
  .filter((u) => u.role !== 'agent')
  .map((u) => `<option value="${u.id}" ${u.id === S.state.me ? 'selected' : ''}>${esc(u.name)} - ${ROLES[u.role].label}</option>`)
  .join('');
$('whoSelect').addEventListener('change', (e) => {
  S.state.me = e.target.value;
  S.log('desk', `${S.me().name} took the desk as ${ROLES[S.me().role].label}.`, S.state.me);
  scheduleSync();
});

$('views').addEventListener('click', (e) => {
  const b = e.target.closest('.view-tab'); if (!b) return;
  view = b.dataset.view;
  for (const t of $('views').children) t.classList.toggle('is-on', t === b);
  for (const v of ['queue', 'authority', 'trail']) $(`view-${v}`).classList.toggle('is-hidden', v !== view);
  render();
});

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  filter = b.dataset.filter;
  for (const c of $('filters').children) c.classList.toggle('is-on', c === b);
  render();
});

// ------------------------------------------------------- panels ----

function renderAuthority() {
  const ms = S.mandateStatus();
  const el = $('authority');

  if (!ms.active) {
    el.innerHTML = `
      <p class="auth-none">
        No mandate is in force. A connected agent can read this desk, prepare drafts and
        ask you to decide, but it cannot move money on its own account.
      </p>
      <p class="auth-none" style="color:var(--ink-3)">
        An agent may ask you for bounded authority. You choose the ceiling, the budget and
        how long it lasts, and you can take it back at any moment.
      </p>`;
    return;
  }

  const m = ms.mandate;
  const budgetPct = Math.max(0, ms.budgetLeftMinor / m.totalMinor);
  const timePct = Math.max(0, ms.msLeft / (new Date(m.expiresAt) - new Date(m.grantedAt)));
  const low = timePct < .25 || budgetPct < .25;
  const mins = Math.floor(ms.msLeft / 60000);
  const secs = Math.floor((ms.msLeft % 60000) / 1000);

  el.innerHTML = `
    <div class="ring-row">
      <div class="ring ${low ? 'is-low' : ''}" id="mandateRing">
        <svg viewBox="0 0 42 42">
          <circle class="track" cx="21" cy="21" r="18" fill="none" stroke-width="3.2"/>
          <circle class="fill" cx="21" cy="21" r="18" fill="none" stroke-width="3.2"
                  stroke-dasharray="113.1" stroke-dashoffset="${(113.1 * (1 - timePct)).toFixed(2)}"/>
        </svg>
        <div class="ring-mid" id="mandateClock">${mins}:${String(secs).padStart(2, '0')}</div>
      </div>
      <div style="min-width:0;display:flex;flex-direction:column;gap:5px">
        <div class="auth-headline">Mandate in force</div>
        <div class="auth-body">Granted by ${esc(S.state.users[m.grantedBy]?.name || m.grantedBy)} at ${clock(m.grantedAt)}.</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:6px">
      <dl class="kv"><dt>Per payment</dt><dd>${money(m.perPaymentMinor, m.ccy)}</dd></dl>
      <dl class="kv"><dt>Budget left</dt><dd>${money(ms.budgetLeftMinor, m.ccy)}</dd></dl>
      <div class="meter ${budgetPct < .25 ? 'is-warn' : ''}"><i style="width:${(budgetPct * 100).toFixed(1)}%"></i></div>
      <dl class="kv"><dt>Rails</dt><dd style="font-family:var(--sans);font-size:12px">${m.rails.map((r) => esc(RAILS[r]?.label || r)).join(', ')}</dd></dl>
      <dl class="kv"><dt>Beneficiaries</dt><dd style="font-family:var(--sans);font-size:12px">${m.knownBeneficiariesOnly ? 'Verified only' : 'Any'}</dd></dl>
    </div>

    <button class="btn btn-danger btn-sm" id="revokeBtn">${iconEl('close')} Revoke now</button>`;

  $('revokeBtn').onclick = () => { S.revokeMandate(S.state.me); scheduleSync(); };
}

function renderRails() {
  const now = S.deskNow();
  const mins = now.getHours() * 60 + now.getMinutes();
  $('rails').innerHTML = Object.entries(RAILS).map(([id, r]) => {
    if (r.cutoff === null) {
      return `<li class="rail-row"><span class="rail-name">${esc(r.label)}</span>
        <span class="rail-left is-shut" style="color:var(--pass)">open</span>
        <span class="rail-bar"><i style="width:100%;background:var(--pass);opacity:.4"></i></span></li>`;
    }
    const left = r.cutoff - mins;
    const shut = left <= 0;
    const soon = left > 0 && left <= 45;
    const pct = shut ? 0 : Math.min(100, (left / (r.cutoff - 8 * 60)) * 100);
    return `<li class="rail-row" data-rail="${id}">
      <span class="rail-name">${esc(r.label)}</span>
      <span class="rail-left ${soon ? 'is-soon' : ''} ${shut ? 'is-shut' : ''}">
        ${shut ? 'closed for today' : `${Math.floor(left / 60)}h ${String(left % 60).padStart(2, '0')}m`}
      </span>
      <span class="rail-bar ${soon ? 'is-soon' : ''}"><i style="width:${Math.max(0, pct).toFixed(1)}%"></i></span>
    </li>`;
  }).join('');
}

function renderExposure() {
  $('exposure').innerHTML = S.state.accounts.map((a) => {
    const pledged = S.state.payments.filter((p) => p.accountId === a.id && ['authorized', 'released'].includes(p.status)).reduce((s, p) => s + p.amountMinor, 0);
    const drafts = S.state.payments.filter((p) => p.accountId === a.id && p.status === 'draft').reduce((s, p) => s + p.amountMinor, 0);
    const free = a.availableMinor - pledged;
    return `<li class="exp-row">
      <div class="exp-top"><span class="exp-name">${esc(a.label.split(' - ')[0])}</span><span class="exp-val">${money(free, a.ccy)}</span></div>
      <div class="meter"><i style="width:${((free / a.availableMinor) * 100).toFixed(1)}%"></i></div>
      <div class="exp-sub">${money(pledged, a.ccy)} pledged${drafts ? `, ${money(drafts, a.ccy)} in drafts` : ''}</div>
    </li>`;
  }).join('');
}

// -------------------------------------------------------- queue ----

const statusClass = (p, r) => {
  if (['released', 'settled'].includes(p.status)) return 's-done';
  if (r.decision === 'blocked') return 's-stop';
  if (r.decision === 'needs_human') return 's-warn';
  return 's-pass';
};

function renderQueue() {
  const rows = S.state.payments.filter((p) => {
    if (filter === 'draft') return p.status === 'draft';
    if (filter === 'done') return ['released', 'settled'].includes(p.status);
    if (filter === 'stuck') return !['released', 'settled'].includes(p.status) && deskCheck(p).decision !== 'allow';
    return true;
  });

  const stuck = S.state.payments.filter((p) => !['released', 'settled'].includes(p.status) && deskCheck(p).decision !== 'allow').length;
  const drafts = S.state.payments.filter((p) => p.status === 'draft').length;
  $('queueSub').textContent = `${drafts} awaiting release, ${stuck} that ${S.me().name.split(' ')[0]} cannot clear alone. Every line is re-evaluated against the desk controls as things change.`;

  if (!rows.length) { $('queue').innerHTML = `<li class="empty">Nothing matches that filter.</li>`; return; }

  const scroller = $('queueScroll');
  const keep = scroller.scrollTop;

  $('queue').innerHTML = rows.map((p) => {
    const r = deskCheck(p);
    const b = S.beneficiary(p.beneficiaryId);
    const done = ['released', 'settled'].includes(p.status);
    const lead = done ? null : r.needs[0];

    const tag = done
      ? `<span class="tag t-accent">${iconEl('check')} ${p.status === 'settled' ? 'Settled' : 'Released'}</span>`
      : r.decision === 'allow'
        ? `<span class="tag t-pass">${iconEl('check')} Clear to release</span>`
        : r.decision === 'blocked'
          ? `<span class="tag t-stop">${iconEl('blocked')} ${esc(lead.title)}</span>`
          : `<span class="tag t-warn">${iconEl('attention')} ${esc(lead.title)}</span>`;

    // One source of truth: the control engine already blocks self-approval,
    // insufficient authority and everything else. The button follows it rather
    // than re-deciding, so the screen can never offer what the desk would refuse.
    const canAct = !done && r.decision !== 'blocked';

    return `<li class="pay ${statusClass(p, r)} ${p.fresh ? 'is-fresh' : ''} ${litPayment === p.id ? 'is-lit' : ''}" data-id="${p.id}">
      <span class="edge"></span>
      <div class="pay-main">
        <div class="pay-l1">
          <span class="pay-id">${p.id}</span>
          <span class="pay-who">${esc(b ? b.name : 'Beneficiary not on file')}</span>
          ${tag}
        </div>
        <div class="pay-l2">
          <b>${esc(RAILS[p.rail]?.label || p.rail)}</b>
          <span>&middot;</span><span>${esc(p.ref || 'no reference')}</span>
          <span>&middot;</span><span>prepared by ${esc(S.state.users[p.createdBy]?.name || p.createdBy)} at ${clock(p.createdAt)}</span>
        </div>
        ${lead ? `<p class="pay-why"><span class="lead">${esc(lead.title)}.</span> ${esc(lead.explain)}</p>` : ''}
      </div>
      <div class="pay-right">
        <span class="pay-amt">${money(p.amountMinor, p.ccy)}</span>
        <div class="pay-actions">
          ${canAct ? `<button class="btn btn-sm" data-act="approve" data-id="${p.id}">${iconEl('seal')} Approve</button>` : ''}
          ${done && p.releasedBy ? `<span class="tag t-mute">by ${esc(p.releasedBy === 'agent' ? 'the agent' : S.state.users[p.releasedBy]?.name || p.releasedBy)}</span>` : ''}
        </div>
      </div>
    </li>`;
  }).join('');

  scroller.scrollTop = keep;
  for (const p of S.state.payments) delete p.fresh;
}

$('queue').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="approve"]');
  if (!b) return;
  const p = S.payment(b.dataset.id);
  const r = S.check(p, { id: S.state.me, role: S.me().role }, 'authorize');
  if (r.decision === 'blocked') {
    S.log('refused', `${S.me().name} could not approve ${p.id}. ${r.needs[0].title}: ${r.needs[0].explain}`, S.state.me);
    return;
  }
  S.recordApproval(p.id, S.state.me, p.amountMinor);
  S.releasePayment(p.id, S.state.me);
  scheduleSync();
});

// ---------------------------------------------------- authority view ----

function renderAuthorityDetail() {
  const ms = S.mandateStatus();
  const tools = toolNames();
  const fresh = new Set(tools.map((t) => t.name).filter((n) => !knownTools.has(n)));

  const people = Object.values(S.state.users).filter((u) => u.role !== 'agent').map((u) => {
    const R = ROLES[u.role];
    const can = [];
    if (R.canMake) can.push('prepare payments');
    if (R.canApprove) can.push(`approve up to ${money(R.singleMinor, 'EUR')} in one payment and ${money(R.dailyMinor, 'EUR')} across a day`);
    if (R.canOverrideHold) can.push('clear a hold');
    if (R.canGrantMandate) can.push('grant an agent a mandate');
    return `<div class="auth-card">
      <h3>${esc(u.name)}</h3>
      <div class="role">${esc(R.label)}${u.id === S.state.me ? ' - at the desk now' : ''}</div>
      <p>${can.length ? `Can ${can.join(', ')}.` : 'Holds no authority to make or approve payments on this desk.'}
      ${R.canApprove ? ` Anything above ${money(R.dualThresholdMinor, 'EUR')} needs a second approver.` : ''}</p>
    </div>`;
  }).join('');

  $('authorityDetail').innerHTML = `<div class="auth-grid">
    <div class="auth-card is-agent">
      <h3>Connected agent</h3>
      <div class="role">${ms.active ? 'Operating under a mandate' : 'No standing authority'}</div>
      <p>${ms.active
        ? `Granted by ${esc(S.state.users[ms.mandate.grantedBy]?.name)}: up to ${money(ms.mandate.perPaymentMinor, ms.mandate.ccy)} per payment, ${money(ms.budgetLeftMinor, ms.mandate.ccy)} of budget remaining, expiring at ${clock(ms.mandate.expiresAt)}. Reason given: ${esc(ms.mandate.reason || 'none recorded')}.`
        : `Can read this desk in full, prepare drafts and put decisions in front of a person. It cannot approve, release or override a hold. An agent is never counted as a second pair of eyes, so no payment can be both prepared and approved without a person involved.`}</p>
      <div class="toolset">
        ${tools.map((t) => `<span class="tool-tag ${t.readOnly ? 'is-ro' : ''} ${fresh.has(t.name) ? 'is-new' : ''}">${t.name}</span>`).join('')}
      </div>
      <p style="margin-top:9px;color:var(--ink-3);font-size:11.5px">
        ${tools.length} tools are registered right now. This list is not fixed: it is recomputed from
        who is at the desk and what authority stands, and re-registered with the browser whenever
        either changes.
      </p>
    </div>
    ${people}
  </div>`;

  knownTools = new Set(tools.map((t) => t.name));
}

// --------------------------------------------------------- trail ----

function renderTrail() {
  $('trail').innerHTML = S.state.audit.slice(0, 80).map((e) => `
    <li><span class="t">${clock(e.at)}</span><span class="x">${esc(e.text)}</span></li>`).join('')
    || `<li class="empty">Nothing has happened on this desk yet.</li>`;
}

function renderTrace() {
  const busy = S.state.lastToolAt && Date.now() - S.state.lastToolAt < 1500;
  $('tracePill').textContent = S.state.agentTrace.length ? (busy ? 'working' : `${S.state.agentTrace.length} calls`) : 'idle';
  $('tracePill').classList.toggle('is-busy', !!busy);

  $('trace').innerHTML = S.state.agentTrace.length
    ? S.state.agentTrace.slice(0, 40).map((t) => `
      <li><span class="s ${t.outcome}"></span><span class="n">${esc(t.tool)}</span><span class="t">${clock(t.at)}</span></li>`).join('')
    : `<li class="empty" style="padding:18px 0">No agent has called anything yet. Open this page in a browser with an agent and it will appear here as it works.</li>`;

  $('undo').innerHTML = S.state.undoStack.length
    ? S.state.undoStack.slice(0, 6).map((u, i) => `
      <li><span class="lbl">${esc(u.label)}</span>${i === 0 ? `<button class="btn btn-sm" id="undoBtn">${iconEl('undo')} Reverse</button>` : ''}</li>`).join('')
    : `<li style="color:var(--ink-3);font-size:12px">Nothing to reverse.</li>`;
  if ($('undoBtn')) $('undoBtn').onclick = () => { S.undoLast(); scheduleSync(); };
}

// ---------------------------------------------------------- dock ----
// Where an agent's tool call sits open, holding, until a person decides.

function renderDock() {
  const key = S.state.pending.map((p) => p.id).join('|');
  if (key === dockKey) return;      // never rebuild under someone's cursor
  dockKey = key;

  $('dock').innerHTML = S.state.pending.map((req) =>
    req.kind === 'mandate' ? mandateCard(req) : decisionCard(req)).join('');

  for (const req of S.state.pending) wireCard(req);
}

const ctlIcon = (s) => s === 'pass' ? 'check' : s === 'warn' ? 'attention' : 'blocked';

function decisionCard(req) {
  const controls = req.controls ? req.controls.controls.filter((c) => c.status !== 'pass') : [];
  return `<div class="ask" data-req="${req.id}">
    <div class="ask-timer" id="timer-${req.id}"></div>
    <div class="ask-head">
      <span class="ask-kicker">${req.kind === 'undo' ? 'The agent wants something reversed' : 'The agent is waiting on you'}</span>
    </div>
    <div class="ask-title">${esc(req.title)}</div>
    <div class="ask-body">${esc(req.body)}</div>
    ${req.note ? `<div class="ask-note"><span class="from">What the agent says</span>${esc(req.note)}</div>` : ''}
    ${controls.length ? `<div class="ask-controls">${controls.map((c) => `
      <div class="ask-ctl c-${c.status === 'block' ? 'stop' : 'warn'}">
        ${iconEl(ctlIcon(c.status))}<div><b>${esc(c.title)}.</b> <span>${esc(c.explain)}</span></div>
      </div>`).join('')}</div>` : ''}
    <div class="ask-foot">
      <input class="ask-reply" id="reply-${req.id}" placeholder="Add a note for the agent, optional">
      <button class="btn btn-sm" data-x="no" data-req="${req.id}">Decline</button>
      <button class="btn btn-primary btn-sm" data-x="yes" data-req="${req.id}">${iconEl('seal')} Authorise</button>
    </div>
  </div>`;
}

function mandateCard(req) {
  const p = req.proposal;
  return `<div class="ask" data-req="${req.id}">
    <div class="ask-timer" id="timer-${req.id}"></div>
    <div class="ask-head"><span class="ask-kicker">The agent is asking for authority</span></div>
    <div class="ask-title">Grant a mandate</div>
    <div class="ask-body">It wants to release routine payments itself instead of interrupting you for each one. Tighten anything below before you grant it.</div>
    <div class="ask-note"><span class="from">Why it says it needs this</span>${esc(p.reason)}</div>
    <div class="ask-scope">
      <div class="scope-f"><label for="per-${req.id}">Most per payment</label>
        <input id="per-${req.id}" value="${(p.perPaymentMinor / 100).toFixed(2)}" inputmode="decimal"></div>
      <div class="scope-f"><label for="tot-${req.id}">Total budget</label>
        <input id="tot-${req.id}" value="${(p.totalMinor / 100).toFixed(2)}" inputmode="decimal"></div>
      <div class="scope-f"><label for="min-${req.id}">Expires in, minutes</label>
        <input id="min-${req.id}" value="${p.minutes}" inputmode="numeric"></div>
      <div class="scope-f"><label for="ben-${req.id}">Beneficiaries</label>
        <select id="ben-${req.id}">
          <option value="known" ${p.knownBeneficiariesOnly ? 'selected' : ''}>Verified on file only</option>
          <option value="any" ${p.knownBeneficiariesOnly ? '' : 'selected'}>Any beneficiary</option>
        </select></div>
      <p class="scope-hint">
        Limits are in ${esc(p.ccy)}, on ${esc(p.rails.map((r) => RAILS[r]?.label || r).join(' and '))}.
        Everything outside this still comes to you. You can revoke it at any moment, and the agent
        loses the tools it depends on the instant you do.
      </p>
    </div>
    <div class="ask-foot">
      <span class="spacer"></span>
      <button class="btn btn-sm" data-x="no" data-req="${req.id}">Refuse</button>
      <button class="btn btn-primary btn-sm" data-x="yes" data-req="${req.id}">${iconEl('shield')} Grant mandate</button>
    </div>
  </div>`;
}

function wireCard(req) {
  const card = document.querySelector(`.ask[data-req="${req.id}"]`);
  if (!card) return;
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const yes = b.dataset.x === 'yes';

    if (req.kind === 'mandate') {
      if (!yes) return req.resolve({ ok: false, reason: 'refused', text: `${S.me().name} refused the mandate.` });
      const num = (id, fb) => {
        const v = parseFloat(String(document.getElementById(`${id}-${req.id}`).value).replace(/,/g, ''));
        return Number.isFinite(v) && v > 0 ? v : fb;
      };
      const per = Math.round(num('per', req.proposal.perPaymentMinor / 100) * 100);
      const tot = Math.max(per, Math.round(num('tot', req.proposal.totalMinor / 100) * 100));
      const mins = Math.round(num('min', req.proposal.minutes));
      const known = document.getElementById(`ben-${req.id}`).value === 'known';
      const granted = S.grantMandate({
        perPaymentMinor: per, totalMinor: tot, ccy: req.proposal.ccy,
        rails: req.proposal.rails, knownBeneficiariesOnly: known, minutes: mins,
        reason: req.proposal.reason, grantedBy: S.state.me,
        expiresAt: new Date(Date.now() + mins * 60000).toISOString(),
      });
      scheduleSync();
      return req.resolve({ ok: true, granted, by: S.state.me });
    }

    const noteEl = document.getElementById(`reply-${req.id}`);
    const note = noteEl ? noteEl.value.trim() : '';
    if (!yes) {
      S.log('refused', `${S.me().name} declined ${req.payment ? req.payment.id : 'the agent\'s request'}${note ? `: ${note}` : '.'}`, S.state.me);
      return req.resolve({ ok: false, reason: 'declined', text: `${S.me().name} declined.${note ? ` They said: "${note}"` : ''}` });
    }
    req.resolve({ ok: true, by: S.state.me, note });
    scheduleSync();
  });
}

// ------------------------------------------------- declarative tool ----
// A plain HTML form is a WebMCP tool. The submit handler holds the agent's call
// open on a promise, exactly as the imperative tools do.

const form = $('handoffForm');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = new FormData(form).get('question');
  if (!e.agentInvoked) return;
  e.respondWith(S.askHuman({
    kind: 'question', title: 'The agent has a question', body: String(q || '').trim() || 'No question was given.',
  }).then((d) => d.ok
    ? `${S.me().name} answered: ${d.note || 'they agreed, without adding anything.'}`
    : d.text));
});
form.addEventListener('toolactivated', () => S.trace('ask_the_desk', {}, 'running'));

// ------------------------------------------------------- live loop ----

let lastTick = 0;
function tick(t) {
  requestAnimationFrame(tick);

  // dock countdown bars, every frame so they read as genuinely live
  for (const req of S.state.pending) {
    const bar = document.getElementById(`timer-${req.id}`);
    if (bar) bar.style.width = `${Math.max(0, (req.expiresAt - Date.now()) / (req.expiresAt - req.at) * 100)}%`;
  }

  if (t - lastTick < 1000) return;
  lastTick = t;

  $('deskClock').textContent = S.deskNow().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  renderRails();
  renderTrace();

  const ms = S.mandateStatus();
  if (ms.active) {
    const clockEl = $('mandateClock'), ring = $('mandateRing');
    if (clockEl) {
      const m = Math.floor(ms.msLeft / 60000), s = Math.floor((ms.msLeft % 60000) / 1000);
      clockEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
      const span = new Date(ms.mandate.expiresAt) - new Date(ms.mandate.grantedAt);
      const pct = Math.max(0, ms.msLeft / span);
      ring.querySelector('.fill').style.strokeDashoffset = (113.1 * (1 - pct)).toFixed(2);
      ring.classList.toggle('is-low', pct < .25);
    }
  } else if (S.state.mandate) {
    // it expired on the clock rather than by anyone's hand
    S.revokeMandate('system');
    scheduleSync();
  }
}
requestAnimationFrame(tick);

// ---------------------------------------------------------- render ----

function render() {
  $('deskClock').textContent = S.deskNow().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  renderAuthority();
  renderRails();
  renderExposure();
  renderDock();
  if (view === 'queue') renderQueue();
  if (view === 'authority') renderAuthorityDetail();
  if (view === 'trail') renderTrail();
  renderTrace();
}

S.subscribe(render);

// -------------------------------------------------------- WebMCP up ----

(async () => {
  const r = await syncTools();
  const chip = $('agentChip'), label = $('agentLabel'), count = $('toolCount');

  if (!r.supported) {
    label.textContent = 'No agent interface in this browser';
    count.textContent = '';
    $('modeNote').textContent = 'This browser does not expose WebMCP, so no agent can connect. The desk is fully operable by hand. For the agent side, open this page in ChatGPT\'s in-app browser, or in Chromium 146 or newer with chrome://flags/#enable-webmcp-testing enabled.';
  } else {
    chip.classList.add('is-live');
    label.textContent = 'Agent interface live';
    count.textContent = `${r.count} tools`;
    $('modeNote').textContent = `Demonstration desk: the data is fictional, the controls evaluated against it are real. ${r.count} tools are registered with this browser and are re-registered whenever authority changes. Nothing leaves this tab.`;
    document.modelContext.addEventListener('toolchange', async () => {
      const t = await document.modelContext.getTools();
      count.textContent = `${t.length} tools`;
    });
  }
  render();
})();

// keyboard: never trap anyone
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = S.state.pending[0];
  if (open) open.resolve({ ok: false, reason: 'dismissed', text: `${S.me().name} dismissed the request without deciding.` });
});
