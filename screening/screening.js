/**
 * Sentinel Screening Bureau - a separate origin that publishes one tool to a
 * named list of partner desks.
 *
 * The point of this file is `exposedTo`. The watchlist below never leaves this
 * origin; what crosses the boundary is a decision and a reason. A partner desk
 * discovers the tool with getTools({ fromOrigins }) and runs it with
 * executeTool, but it can neither read these records nor add to them.
 */

/** Origins allowed to see and call this bureau's tool. Nobody else can. */
const PARTNERS = [
  'https://mandate-webmcp.vercel.app',
  'http://localhost:4321',
];

/** Held here, published never. */
const WATCHLIST = [
  {
    name: 'Volkov Trading OU', country: 'EE', status: 'match',
    reason: 'A controlling shareholder matches an EU consolidated sanctions entry on name and date of birth.',
    listed: '2026-06-11', reference: 'EU-CONS-2026-4417',
  },
  {
    name: 'Ardent Fabrication Oy', country: 'FI', status: 'clear',
    reason: 'No sanctions or PEP match. The counterparty is new, so the bureau records no payment history for it.',
    listed: null, reference: null,
  },
  {
    name: 'Northwind GmbH', country: 'DE', status: 'clear',
    reason: 'No match. Screened continuously since 2024 with no change.',
    listed: null, reference: null,
  },
  {
    name: 'Meridian Logistics BV', country: 'NL', status: 'clear',
    reason: 'No match. Screened continuously since 2024 with no change.',
    listed: null, reference: null,
  },
  {
    name: 'Castellan Steel SA', country: 'ES', status: 'clear',
    reason: 'No match. A prior 2025 adverse-media flag was reviewed and closed.',
    listed: null, reference: null,
  },
  {
    name: 'Kestrel Precision Ltd', country: 'GB', status: 'clear',
    reason: 'No match. Screened continuously since 2025 with no change.',
    listed: null, reference: null,
  },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const find = (q) => {
  const n = norm(q);
  return WATCHLIST.find((w) => norm(w.name) === n)
    || WATCHLIST.find((w) => norm(w.name).includes(n) || n.includes(norm(w.name)));
};

// ---------------------------------------------------------------- render ----
document.getElementById('origins').innerHTML = PARTNERS.map((o) => `<li>${o}</li>`).join('');
document.getElementById('list').innerHTML = WATCHLIST.map((w) => `
  <li>
    <span class="nm">${w.name}</span>
    <span class="tag ${w.status === 'match' ? 't-match' : 't-clear'}">${w.status === 'match' ? 'match' : 'clear'}</span>
    <span class="why">${w.reason}${w.reference ? ` Reference ${w.reference}, listed ${w.listed}.` : ''}</span>
  </li>`).join('');

// ---------------------------------------------------------------- WebMCP ----
const status = document.getElementById('status');

if (!('modelContext' in document)) {
  status.textContent = 'This browser does not expose WebMCP, so nothing is published from this origin right now. The bureau page itself still works.';
} else {
  await document.modelContext.registerTool({
    name: 'recheck_beneficiary_screening',
    description: 'Re-run sanctions and politically-exposed-person screening for one counterparty by name, against the Sentinel bureau watchlist, and return the current decision with the reason behind it. Use this when a payment is held on a screening match and you need to know whether the match still stands.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The counterparty name exactly as it appears on the payment, for example "Volkov Trading OU".' },
      },
      required: ['name'],
    },
    execute: async ({ name }) => {
      const hit = find(name);
      if (!hit) {
        return {
          content: [{
            type: 'text',
            text: `Sentinel holds no screening record for "${name}". That is not a clearance: an absent record means this counterparty has never been screened by this bureau, and it should be treated as unscreened rather than clear.`,
          }],
        };
      }
      const text = hit.status === 'match'
        ? `Sentinel screening for ${hit.name} (${hit.country}): the match still stands as of today. ${hit.reason} Listed ${hit.listed}, reference ${hit.reference}. Payments to this counterparty should remain stopped, and only the listing authority or your compliance function can change that.`
        : `Sentinel screening for ${hit.name} (${hit.country}): clear as of today. ${hit.reason}`;
      return { content: [{ type: 'text', text }] };
    },
  }, { exposedTo: PARTNERS });

  status.innerHTML = `Published to ${PARTNERS.length} partner origins as <code>recheck_beneficiary_screening</code>. `
    + 'Only those origins can discover or call it.';
}
