/**
 * Mandate - demo desk.
 *
 * This is a demo environment, and the app says so on screen. The DATA is
 * fictional; the CONTROLS evaluated against it are not. Every trap below exists
 * because it is a real thing that stops a real payment on a real desk.
 *
 * Dates are computed relative to load time so the desk is always "today".
 */

const D = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const iso = (d) => d.toISOString();
const on = (d) => d.toISOString().slice(0, 10);

export const DESK = {
  org: 'Halden Industries',
  desk: 'Group Treasury - Payment Operations',
  demo: true,
};

export const USERS = {
  'd.aneja': { id: 'd.aneja', name: 'Daksh Aneja', role: 'controller', initials: 'DA', online: true },
  'p.raghavan': { id: 'p.raghavan', name: 'Priya Raghavan', role: 'officer', initials: 'PR', online: true },
  'j.okafor': { id: 'j.okafor', name: 'Jomo Okafor', role: 'analyst', initials: 'JO', online: true },
  's.lindqvist': { id: 's.lindqvist', name: 'Sanna Lindqvist', role: 'compliance', initials: 'SL', online: false },
  'agent': { id: 'agent', name: 'Connected agent', role: 'agent', initials: 'AI', online: true },
};

export const ACCOUNTS = [
  { id: 'ACC-EUR-01', label: 'EUR Operating - Rabobank', ccy: 'EUR', availableMinor: 184_20_00 * 100 / 100 * 100, iban: 'NL91 RABO 0417 1643 00' },
  { id: 'ACC-GBP-01', label: 'GBP Collections - Barclays', ccy: 'GBP', availableMinor: 61_40_000, iban: 'GB29 BARC 2003 1926 8191 55' },
  { id: 'ACC-USD-01', label: 'USD Reserve - Citi', ccy: 'USD', availableMinor: 9_82_00_000, iban: 'US64 CITI 0390 0000 0329 3701' },
];
// available balances, stated explicitly in minor units to avoid arithmetic drift
ACCOUNTS[0].availableMinor = 1_842_000_00; // EUR 1,842,000.00
ACCOUNTS[1].availableMinor = 614_000_00; // GBP 614,000.00
ACCOUNTS[2].availableMinor = 9_820_000_00; // USD 9,820,000.00

export const BENEFICIARIES = [
  { id: 'BEN-01', name: 'Northwind GmbH', country: 'DE', iban: 'DE89 3704 0044 0532 0130 00', status: 'verified', screening: 'clear', verifiedOn: on(daysAgo(412)), priorPayments: 63, addedDaysAgo: 412, category: 'Raw materials' },
  { id: 'BEN-02', name: 'Meridian Logistics BV', country: 'NL', iban: 'NL02 ABNA 0123 4567 89', status: 'verified', screening: 'clear', verifiedOn: on(daysAgo(287)), priorPayments: 41, addedDaysAgo: 287, category: 'Freight' },
  { id: 'BEN-03', name: 'Castellan Steel SA', country: 'ES', iban: 'ES91 2100 0418 4502 0005 1332', status: 'verified', screening: 'clear', verifiedOn: on(daysAgo(198)), priorPayments: 28, addedDaysAgo: 198, category: 'Raw materials' },
  { id: 'BEN-04', name: 'Kestrel Precision Ltd', country: 'GB', iban: 'GB33 BUKB 2020 1555 5555 55', status: 'verified', screening: 'clear', verifiedOn: on(daysAgo(96)), priorPayments: 12, addedDaysAgo: 96, category: 'Tooling' },
  { id: 'BEN-05', name: 'Ardent Fabrication Oy', country: 'FI', iban: 'FI21 1234 5600 0007 85', status: 'unverified', screening: 'clear', verifiedOn: null, priorPayments: 0, addedDaysAgo: 1, category: 'Subassembly' },
  { id: 'BEN-06', name: 'Volkov Trading OU', country: 'EE', iban: 'EE38 2200 2210 2014 5685', status: 'unverified', screening: 'match', screeningNote: 'name and date-of-birth match against an EU consolidated sanctions entry for a controlling shareholder', verifiedOn: null, priorPayments: 0, addedDaysAgo: 3, category: 'Components' },
  { id: 'BEN-07', name: 'Halden Industries Inc (US)', country: 'US', iban: 'US12 CITI 0000 0000 1234 5678', status: 'verified', screening: 'clear', verifiedOn: on(daysAgo(730)), priorPayments: 96, addedDaysAgo: 730, category: 'Intercompany' },
];

/**
 * The queue. Each entry exists to exercise a specific control - the comment
 * says which, so nothing here is decoration.
 */
export const PAYMENTS = [
  // Clean, small, verified counterparty. These are what a mandate can sweep.
  { id: 'PMT-2041', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-01', amountMinor: 4_820_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'INV-NW-88412', status: 'draft', createdBy: 'j.okafor', createdAt: D(8, 12), updatedAt: D(8, 12), evidence: [{ label: 'Invoice INV-NW-88412', kind: 'invoice' }] },
  { id: 'PMT-2042', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-02', amountMinor: 2_140_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'FRT-Q3-0912', status: 'draft', createdBy: 'j.okafor', createdAt: D(8, 14), updatedAt: D(8, 14), evidence: [{ label: 'Freight note FRT-Q3-0912', kind: 'invoice' }] },
  { id: 'PMT-2043', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-03', amountMinor: 3_960_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'INV-CS-20551', status: 'draft', createdBy: 'j.okafor', createdAt: D(8, 21), updatedAt: D(8, 21), evidence: [{ label: 'Invoice INV-CS-20551', kind: 'invoice' }] },
  { id: 'PMT-2044', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-01', amountMinor: 1_275_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'INV-NW-88455', status: 'draft', createdBy: 'j.okafor', createdAt: D(8, 33), updatedAt: D(8, 33), evidence: [{ label: 'Invoice INV-NW-88455', kind: 'invoice' }] },
  { id: 'PMT-2045', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-02', amountMinor: 890_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'FRT-Q3-0918', status: 'draft', createdBy: 'j.okafor', createdAt: D(8, 40), updatedAt: D(8, 40), evidence: [{ label: 'Freight note FRT-Q3-0918', kind: 'invoice' }] },

  // Missing evidence - warns, does not block.
  { id: 'PMT-2046', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-03', amountMinor: 6_310_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'CS-ADHOC', status: 'draft', createdBy: 'j.okafor', createdAt: D(8, 47), updatedAt: D(8, 47), evidence: [] },

  // New beneficiary, one day old, never verified out-of-band. Where fraud lives.
  { id: 'PMT-2047', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-05', amountMinor: 47_500_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'AF-SETUP-01', status: 'draft', createdBy: 'j.okafor', createdAt: D(9, 2), updatedAt: D(9, 2), evidence: [{ label: 'Purchase order PO-4471', kind: 'po' }] },

  // Sanctions screening match. Hard stop, not overridable by treasury.
  { id: 'PMT-2048', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-06', amountMinor: 18_900_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'VT-11209', status: 'held', createdBy: 'j.okafor', createdAt: D(9, 11), updatedAt: D(9, 11), evidence: [{ label: 'Invoice VT-11209', kind: 'invoice' }] },

  // Above a Payments Officer single-payment ceiling. Needs escalation.
  { id: 'PMT-2049', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-01', amountMinor: 412_000_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'INV-NW-88500-Q3', status: 'draft', createdBy: 'p.raghavan', createdAt: D(9, 25), updatedAt: D(9, 25), evidence: [{ label: 'Quarterly settlement INV-NW-88500-Q3', kind: 'invoice' }, { label: 'Supply agreement SA-2024-11 clause 7', kind: 'contract' }] },

  // Duplicate pair: 2050 already went out, 2051 looks identical.
  { id: 'PMT-2050', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-04', amountMinor: 9_450_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'INV-KP-3391', status: 'settled', createdBy: 'j.okafor', createdAt: D(7, 5), updatedAt: D(7, 40), evidence: [{ label: 'Invoice INV-KP-3391', kind: 'invoice' }] },
  { id: 'PMT-2051', accountId: 'ACC-EUR-01', beneficiaryId: 'BEN-04', amountMinor: 9_450_00, ccy: 'EUR', rail: 'sepa_ct', ref: 'INV-KP-3391', status: 'draft', createdBy: 'j.okafor', createdAt: D(9, 44), updatedAt: D(9, 44), evidence: [{ label: 'Invoice INV-KP-3391', kind: 'invoice' }] },

  // GBP on a GBP rail, fine. Sits on a different account.
  { id: 'PMT-2052', accountId: 'ACC-GBP-01', beneficiaryId: 'BEN-04', amountMinor: 22_800_00, ccy: 'GBP', rail: 'fps', ref: 'INV-KP-3402', status: 'draft', createdBy: 'p.raghavan', createdAt: D(9, 52), updatedAt: D(9, 52), evidence: [{ label: 'Invoice INV-KP-3402', kind: 'invoice' }] },

  // Currency on the wrong rail - SEPA cannot carry GBP.
  { id: 'PMT-2053', accountId: 'ACC-GBP-01', beneficiaryId: 'BEN-04', amountMinor: 5_600_00, ccy: 'GBP', rail: 'sepa_ct', ref: 'INV-KP-3405', status: 'draft', createdBy: 'j.okafor', createdAt: D(10, 3), updatedAt: D(10, 3), evidence: [{ label: 'Invoice INV-KP-3405', kind: 'invoice' }] },

  // Intercompany USD on SWIFT, large, needs dual authorisation.
  { id: 'PMT-2054', accountId: 'ACC-USD-01', beneficiaryId: 'BEN-07', amountMinor: 1_250_000_00, ccy: 'USD', rail: 'swift', ref: 'IC-SWEEP-Q3', status: 'draft', createdBy: 'p.raghavan', createdAt: D(10, 15), updatedAt: D(10, 15), evidence: [{ label: 'Intercompany sweep instruction IC-2026-Q3', kind: 'instruction' }] },

  // Deliberately unfunded once the queue above is pledged.
  { id: 'PMT-2055', accountId: 'ACC-GBP-01', beneficiaryId: 'BEN-04', amountMinor: 598_000_00, ccy: 'GBP', rail: 'chaps', ref: 'KP-MILESTONE-3', status: 'draft', createdBy: 'p.raghavan', createdAt: D(10, 28), updatedAt: D(10, 28), evidence: [{ label: 'Milestone certificate MC-3', kind: 'contract' }] },
];

export const AUDIT_SEED = [
  { at: D(7, 40), actor: 'p.raghavan', kind: 'release', text: 'Priya Raghavan released PMT-2050 for GBP 9,450.00 to Kestrel Precision Ltd on SEPA Credit Transfer.' },
  { at: D(9, 11), actor: 'system', kind: 'hold', text: 'Screening placed PMT-2048 on hold: the beneficiary Volkov Trading OU matches an EU consolidated sanctions entry.' },
];

export { iso };
