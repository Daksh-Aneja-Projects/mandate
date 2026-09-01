/**
 * Mandate - control engine.
 *
 * This is the part that must not be theatre. Every control here is a real
 * evaluation over real state; nothing returns a hardcoded verdict, and nothing
 * fabricates a number. If a control cannot evaluate, it says so.
 *
 * Money is always integer minor units (cents/pence). No floats touch an amount.
 */

/** Rail configuration. Representative desk values for a demo treasury; each
 *  desk configures its own. Times are local to the rail's clearing centre and
 *  are expressed as minutes past midnight. */
export const RAILS = {
  sepa_inst: { label: 'SEPA Instant', ccy: 'EUR', cutoff: null, settles: 'seconds', maxMinor: 10000000 },
  sepa_ct: { label: 'SEPA Credit Transfer', ccy: 'EUR', cutoff: 16 * 60, settles: 'same day' },
  swift: { label: 'SWIFT', ccy: '*', cutoff: 15 * 60, settles: '1-2 days' },
  chaps: { label: 'CHAPS', ccy: 'GBP', cutoff: 17 * 60 + 40, settles: 'same day' },
  fps: { label: 'Faster Payments', ccy: 'GBP', cutoff: null, settles: 'seconds', maxMinor: 100000000 },
  ach: { label: 'ACH', ccy: 'USD', cutoff: 16 * 60 + 30, settles: 'next day' },
};

/** Roles and the authority each carries. A desk's mandate document, in code. */
export const ROLES = {
  analyst: {
    label: 'Payments Analyst',
    canMake: true, canApprove: false, canOverrideHold: false, canGrantMandate: false,
    singleMinor: 0, dailyMinor: 0, dualThresholdMinor: 0,
  },
  officer: {
    label: 'Payments Officer',
    canMake: true, canApprove: true, canOverrideHold: false, canGrantMandate: true,
    singleMinor: 5000000, dailyMinor: 25000000, dualThresholdMinor: 2500000,
  },
  controller: {
    label: 'Treasury Controller',
    canMake: true, canApprove: true, canOverrideHold: true, canGrantMandate: true,
    singleMinor: 50000000, dailyMinor: 200000000, dualThresholdMinor: 10000000,
  },
  compliance: {
    label: 'Compliance Officer',
    canMake: false, canApprove: true, canOverrideHold: true, canGrantMandate: false,
    singleMinor: 0, dailyMinor: 0, dualThresholdMinor: 0,
  },
  agent: {
    // An agent is never a person. It can never satisfy four-eyes, and it can
    // never hold approval authority of its own - only borrowed, scoped,
    // expiring authority via a mandate a human grants.
    label: 'Agent',
    canMake: true, canApprove: false, canOverrideHold: false, canGrantMandate: false,
    singleMinor: 0, dailyMinor: 0, dualThresholdMinor: 0,
  },
};

export const money = (minor, ccy) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: ccy, minimumFractionDigits: 2 })
    .format(minor / 100);

/** "1 day", "3 days". Never "1 day(s)" - a person is reading this. */
const plural = (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;

const pass = (id, title, explain) => ({ id, status: 'pass', title, explain, remedies: [] });
const warn = (id, title, explain, remedies = []) => ({ id, status: 'warn', title, explain, remedies });
const block = (id, title, explain, remedies = []) => ({ id, status: 'block', title, explain, remedies });

/**
 * Evaluate every control for one payment, for one actor, against world state.
 *
 * @param {object} p        payment
 * @param {object} actor    { id, role } - the identity attempting the action
 * @param {object} world    { beneficiaries, accounts, payments, now, mandate, approvals }
 * @param {'release'|'authorize'} intent
 * @returns {{decision:'allow'|'needs_human'|'blocked', controls:Array, needs:Array}}
 */
export function evaluate(p, actor, world, intent = 'authorize') {
  const role = ROLES[actor.role];
  const controls = [];
  /** People are named, never referred to by their account id. */
  const who = (id) => world.nameOf?.(id) ?? id;
  if (!role) {
    return {
      decision: 'blocked',
      controls: [block('identity', 'Unknown role', `The role "${actor.role}" is not defined on this desk, so no authority can be derived for it.`)],
      needs: [],
    };
  }

  const ben = world.beneficiaries.find((b) => b.id === p.beneficiaryId);
  const acct = world.accounts.find((a) => a.id === p.accountId);
  const rail = RAILS[p.rail];

  // ---- 1. Segregation of duties: an agent is never an approver. --------------
  if (actor.role === 'agent' && intent !== 'draft') {
    const m = world.mandate;
    const cover = m ? mandateCovers(m, p, world) : null;
    if (!cover) {
      controls.push(block('sod', 'Segregation of duties',
        'An agent cannot authorise a payment on its own authority. Authority has to be granted by a person, scoped, and time-boxed.',
        [{ tool: 'propose_mandate', why: 'Ask a person for scoped, expiring release authority.' },
         { tool: 'request_authorization', why: 'Route this single payment to a person for approval.' }]));
    } else if (!cover.ok) {
      controls.push(block('mandate_scope', 'Outside mandate scope', cover.why,
        [{ tool: 'request_authorization', why: 'Route this payment to a person instead.' },
         { tool: 'propose_mandate', why: 'Ask for a wider mandate, stating why.' }]));
    } else {
      controls.push(pass('mandate_scope', 'Within mandate scope', cover.why));
    }
  }

  // ---- 2. Four-eyes (maker-checker) -----------------------------------------
  if (intent === 'authorize' || intent === 'release') {
    if (p.createdBy === actor.id) {
      controls.push(block('four_eyes', 'Four-eyes principle',
        `${who(actor.id)} prepared this payment, so ${who(actor.id)} cannot also approve it. Approval has to come from a different person.`,
        [{ tool: 'request_authorization', why: 'Send it to a colleague who did not prepare it.' }]));
    } else if (actor.role === 'agent') {
      // An agent is never a pair of eyes. Under a mandate, the person who
      // granted it is the second pair - given ex ante, over a scope, rather
      // than per payment. If that granter is also the maker, four-eyes has
      // genuinely failed and no mandate can paper over it.
      const g = world.mandate && !world.mandate.revokedAt ? world.mandate.grantedBy : null;
      if (!g) {
        controls.push(warn('four_eyes', 'Four-eyes principle',
          'An agent does not count as a second pair of eyes. Approval still has to come from a person other than the maker.'));
      } else if (g === p.createdBy) {
        controls.push(block('four_eyes', 'Four-eyes principle',
          `${who(g)} prepared this payment and also granted the mandate the agent is acting under, so only one person has touched it. A mandate cannot stand in for the second pair of eyes.`,
          [{ tool: 'request_authorization', why: 'Route this payment to a different person.' }]));
      } else {
        controls.push(pass('four_eyes', 'Four-eyes principle',
          `Prepared by ${who(p.createdBy)}; ${who(g)} is the second pair of eyes, given in advance by granting the mandate the agent is acting under.`));
      }
    } else {
      controls.push(pass('four_eyes', 'Four-eyes principle',
        `Prepared by ${who(p.createdBy)}, approved by ${who(actor.id)}. Two distinct people.`));
    }
  }

  // ---- 3. Approval authority ------------------------------------------------
  if (intent === 'authorize' || intent === 'release') {
    if (!role.canApprove && actor.role !== 'agent') {
      controls.push(block('authority', 'No approval authority',
        `${role.label} is a maker role on this desk. It can prepare and route payments but cannot approve them.`,
        [{ tool: 'request_authorization', why: 'Route to a role that carries approval authority.' }]));
    } else if (role.canApprove) {
      if (p.amountMinor > role.singleMinor) {
        controls.push(block('limit_single', 'Above single-payment limit',
          `${money(p.amountMinor, p.ccy)} is above the ${money(role.singleMinor, p.ccy)} single-payment ceiling for ${role.label}.`,
          [{ tool: 'request_authorization', why: 'Escalate to a role with a higher ceiling.' }]));
      } else {
        controls.push(pass('limit_single', 'Within single-payment limit',
          `${money(p.amountMinor, p.ccy)} is inside the ${money(role.singleMinor, p.ccy)} ceiling for ${role.label}.`));
      }

      const usedToday = dailyUsed(world, actor.id);
      if (usedToday + p.amountMinor > role.dailyMinor) {
        controls.push(block('limit_daily', 'Above daily cumulative limit',
          `${who(actor.id)} has already approved ${money(usedToday, p.ccy)} today. This payment would take the total to ${money(usedToday + p.amountMinor, p.ccy)}, past the ${money(role.dailyMinor, p.ccy)} daily ceiling.`,
          [{ tool: 'request_authorization', why: 'Route to an approver with headroom remaining today.' }]));
      } else {
        controls.push(pass('limit_daily', 'Within daily limit',
          `${money(role.dailyMinor - usedToday - p.amountMinor, p.ccy)} of daily authority would remain after this payment.`));
      }

      if (p.amountMinor > role.dualThresholdMinor) {
        const others = (world.approvals[p.id] || []).filter((a) => a.by !== actor.id && a.by !== p.createdBy);
        if (others.length === 0) {
          controls.push(warn('dual_auth', 'Second approver required',
            `Payments above ${money(role.dualThresholdMinor, p.ccy)} need two approvers. One approval is recorded so far.`,
            [{ tool: 'request_authorization', why: 'Route to a second approver to complete dual authorisation.' }]));
        } else {
          controls.push(pass('dual_auth', 'Dual authorisation satisfied',
            `Approved by ${who(actor.id)} and ${others.map((a) => who(a.by)).join(', ')}.`));
        }
      }
    }
  }

  // ---- 4. Beneficiary verification -------------------------------------------
  if (!ben) {
    controls.push(block('beneficiary', 'Beneficiary not on file',
      'This payment points at a beneficiary that is not in the beneficiary register, so the destination account cannot be verified.',
      [{ tool: 'search_beneficiaries', why: 'Find the correct beneficiary record first.' }]));
  } else if (ben.screening === 'match') {
    controls.push(block('screening', 'Sanctions screening match',
      `${ben.name} has an open screening match (${ben.screeningNote || 'reason not recorded'}). Payments to this beneficiary are stopped until Compliance clears it. This is not overridable by the treasury desk.`,
      [{ tool: 'explain_hold', why: 'Read the full screening record.' }]));
  } else if (ben.status === 'unverified') {
    controls.push(warn('beneficiary', 'Beneficiary not yet verified',
      `${ben.name} was added ${plural(ben.addedDaysAgo, 'day')} ago and has not had its account details confirmed out-of-band. New-beneficiary risk is where most payment fraud lands, so this needs a person to confirm.`,
      [{ tool: 'request_authorization', why: 'A person confirms the beneficiary and approves in one step.' }]));
  } else {
    controls.push(pass('beneficiary', 'Beneficiary verified',
      `${ben.name} was verified on ${ben.verifiedOn} and has settled ${plural(ben.priorPayments, 'prior payment')} without exception.`));
  }

  // ---- 5. Funding ------------------------------------------------------------
  if (!acct) {
    controls.push(block('funding', 'Source account unknown',
      'The debit account on this payment is not in the account register, so available balance cannot be checked.'));
  } else if (acct.ccy !== p.ccy) {
    controls.push(warn('funding', 'Cross-currency debit',
      `The payment is in ${p.ccy} but ${acct.label} is a ${acct.ccy} account. An FX leg is implied and is not priced here.`));
  } else {
    const pledged = pledgedOn(world, acct.id, p.id);
    const free = acct.availableMinor - pledged;
    if (p.amountMinor > free) {
      controls.push(block('funding', 'Insufficient available balance',
        `${acct.label} has ${money(acct.availableMinor, acct.ccy)} available, of which ${money(pledged, acct.ccy)} is already pledged to payments queued today. That leaves ${money(free, acct.ccy)}, short of ${money(p.amountMinor, p.ccy)}.`,
        [{ tool: 'get_exposure', why: 'See what is pledged and whether anything can be re-sequenced.' }]));
    } else {
      controls.push(pass('funding', 'Funded',
        `${money(free, acct.ccy)} unpledged on ${acct.label} after existing queued payments.`));
    }
  }

  // ---- 6. Rail and cut-off ---------------------------------------------------
  if (!rail) {
    controls.push(block('rail', 'Unknown rail', `"${p.rail}" is not a rail configured on this desk.`));
  } else {
    if (rail.ccy !== '*' && rail.ccy !== p.ccy) {
      controls.push(block('rail', 'Rail does not carry this currency',
        `${rail.label} settles ${rail.ccy} only, and this payment is in ${p.ccy}.`,
        [{ tool: 'amend_payment', why: 'Move it to a rail that carries this currency.' }]));
    } else if (rail.maxMinor && p.amountMinor > rail.maxMinor) {
      controls.push(block('rail', 'Above rail ceiling',
        `${rail.label} carries at most ${money(rail.maxMinor, rail.ccy)} per payment; this is ${money(p.amountMinor, p.ccy)}.`,
        [{ tool: 'amend_payment', why: 'Move it to a rail with a higher ceiling.' }]));
    } else {
      controls.push(pass('rail', 'Rail accepts this payment',
        `${rail.label}, settling in ${rail.settles}.`));
    }

    const mins = world.now.getHours() * 60 + world.now.getMinutes();
    if (rail.cutoff !== null) {
      if (mins >= rail.cutoff) {
        controls.push(warn('cutoff', 'Past today\'s cut-off',
          `${rail.label} closed for today at ${hhmm(rail.cutoff)}. Releasing now dates the payment for the next business day.`));
      } else {
        const left = rail.cutoff - mins;
        controls.push((left <= 30 ? warn : pass)('cutoff', left <= 30 ? 'Cut-off approaching' : 'Inside cut-off',
          `${plural(left, 'minute')} until ${rail.label} closes at ${hhmm(rail.cutoff)}.`));
      }
    } else {
      controls.push(pass('cutoff', 'No cut-off', `${rail.label} clears around the clock.`));
    }
  }

  // ---- 7. Duplicate detection -------------------------------------------------
  const dupe = world.payments.find((q) =>
    q.id !== p.id && q.beneficiaryId === p.beneficiaryId && q.amountMinor === p.amountMinor &&
    q.ccy === p.ccy && ['authorized', 'released', 'settled'].includes(q.status) &&
    hoursBetween(new Date(q.updatedAt), world.now) < 24);
  if (dupe) {
    controls.push(warn('duplicate', 'Possible duplicate',
      `${dupe.id} sent the same amount to the same beneficiary ${plural(Math.round(hoursBetween(new Date(dupe.updatedAt), world.now)), 'hour')} ago. If this is a genuine second payment a person should say so explicitly.`,
      [{ tool: 'get_payment', why: `Compare against ${dupe.id} before proceeding.` }]));
  }

  // ---- 8. Evidence -----------------------------------------------------------
  if (!p.evidence || p.evidence.length === 0) {
    controls.push(warn('evidence', 'No supporting evidence',
      'Nothing is attached that explains why this payment is owed. Audit expects an invoice, contract reference or written instruction.',
      [{ tool: 'attach_evidence', why: 'Attach the invoice or instruction this payment settles.' }]));
  } else {
    controls.push(pass('evidence', 'Evidence attached', p.evidence.map((e) => e.label).join('; ')));
  }

  const blocked = controls.filter((c) => c.status === 'block');
  const warned = controls.filter((c) => c.status === 'warn');
  const decision = blocked.length ? 'blocked' : warned.length ? 'needs_human' : 'allow';

  // What a desk needs told first is what is wrong with the payment, not who
  // happens to be asking. A sanctions match outranks a missing second signature.
  const needs = (blocked.length ? blocked : warned)
    .slice().sort((a, b) => (RANK[a.id] ?? 50) - (RANK[b.id] ?? 50));

  return { decision, controls, needs };
}

const RANK = {
  identity: 0, screening: 1, funding: 2, beneficiary: 3, rail: 4,
  sod: 5, mandate_scope: 6, four_eyes: 7, authority: 8,
  limit_single: 9, limit_daily: 10, duplicate: 11, dual_auth: 12,
  cutoff: 13, evidence: 14,
};

/** Does an active mandate cover this payment? Returns null if no mandate at all. */
export function mandateCovers(m, p, world) {
  if (!m || m.revokedAt) return null;
  const who = (id) => world.nameOf?.(id) ?? id;
  const expired = new Date(m.expiresAt) <= world.now;
  if (expired) return { ok: false, why: `The mandate granted by ${who(m.grantedBy)} expired at ${new Date(m.expiresAt).toLocaleTimeString()}.` };
  // A mandate is denominated. Comparing its ceiling against another currency
  // would be meaningless arithmetic on a money path, so it simply does not carry.
  if (p.ccy !== m.ccy)
    return { ok: false, why: `The mandate is denominated in ${m.ccy} and this payment is in ${p.ccy}. A mandate does not carry across currencies.` };
  if (p.amountMinor > m.perPaymentMinor)
    return { ok: false, why: `The mandate caps single payments at ${money(m.perPaymentMinor, m.ccy)}; this is ${money(p.amountMinor, p.ccy)}.` };
  const spent = m.spentMinor || 0;
  if (spent + p.amountMinor > m.totalMinor)
    return { ok: false, why: `The mandate has ${money(m.totalMinor - spent, m.ccy)} of its ${money(m.totalMinor, m.ccy)} budget left; this payment needs ${money(p.amountMinor, p.ccy)}.` };
  if (m.rails.length && !m.rails.includes(p.rail))
    return { ok: false, why: `The mandate covers ${m.rails.map((r) => RAILS[r]?.label || r).join(', ')} only, and this is on ${RAILS[p.rail]?.label || p.rail}.` };
  const ben = world.beneficiaries.find((b) => b.id === p.beneficiaryId);
  if (m.knownBeneficiariesOnly && (!ben || ben.status !== 'verified'))
    return { ok: false, why: `The mandate is limited to beneficiaries already verified on file, and ${ben ? ben.name : 'this beneficiary'} is not.` };
  const leftMs = new Date(m.expiresAt) - world.now;
  return {
    ok: true,
    why: `Covered by the mandate ${who(m.grantedBy)} granted at ${new Date(m.grantedAt).toLocaleTimeString()}: up to ${money(m.perPaymentMinor, m.ccy)} per payment, ${money(m.totalMinor - spent, m.ccy)} of budget left, ${plural(Math.max(0, Math.round(leftMs / 60000)), 'minute')} before it expires.`,
  };
}

const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const hoursBetween = (a, b) => Math.abs(b - a) / 36e5;

function dailyUsed(world, actorId) {
  const day = world.now.toDateString();
  return Object.values(world.approvals).flat()
    .filter((a) => a.by === actorId && new Date(a.at).toDateString() === day)
    .reduce((s, a) => s + a.amountMinor, 0);
}

function pledgedOn(world, accountId, exceptId) {
  return world.payments
    .filter((q) => q.accountId === accountId && q.id !== exceptId && ['authorized', 'released'].includes(q.status))
    .reduce((s, q) => s + q.amountMinor, 0);
}

/** Plain-English one-liner for an evaluation. Never a code, never an enum. */
export function narrate(result, p) {
  if (result.decision === 'allow') return `All controls pass for ${p.id}.`;
  const first = result.needs[0];
  const n = result.needs.length;
  return `${first.title}: ${first.explain}${n > 1 ? ` (${n - 1} other control${n > 2 ? 's' : ''} also need attention.)` : ''}`;
}
