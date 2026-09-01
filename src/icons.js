/**
 * Mandate - icon set. Drawn, not typed. No emoji anywhere in this product.
 * Every icon is a 24x24 stroke path on currentColor so it inherits state.
 */
const svg = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;

export const icon = {
  /** The mark: a boundary with a deliberate opening, and authority acting inside it. */
  mark: `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M16 3.5a12.5 12.5 0 1 0 12.5 12.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M22.5 6.6 28.5 16h-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="16" cy="16" r="4.6" fill="currentColor"/>
  </svg>`,

  seal: svg('<circle cx="12" cy="10" r="6"/><path d="M9 15.5 8 22l4-2 4 2-1-6.5"/>'),
  shield: svg('<path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z"/>'),
  check: svg('<path d="m4.5 12.5 5 5 10-11"/>'),
  attention: svg('<path d="M12 8.5v5M12 17h.01"/><path d="M10.3 3.9 2.7 17.1A2 2 0 0 0 4.4 20h15.2a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'),
  blocked: svg('<circle cx="12" cy="12" r="8.5"/><path d="m6.5 6.5 11 11"/>'),
  person: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>'),
  people: svg('<circle cx="9" cy="8.5" r="3.2"/><path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M17.6 14.4a6.2 6.2 0 0 1 3.6 5.1"/>'),
  agent: svg('<rect x="4" y="7.5" width="16" height="12" rx="3.2"/><path d="M12 3v4.5M8.5 13h.01M15.5 13h.01M9.5 16.4h5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>'),
  rail: svg('<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18.5" cy="17" r="2"/>'),
  wallet: svg('<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16.5 14.5h.01"/>'),
  ledger: svg('<path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 10h8M8 14h8M8 18h5"/>'),
  undo: svg('<path d="M4 9h9a5.5 5.5 0 0 1 0 11h-5"/><path d="m7.5 5.5-3.5 3.5 3.5 3.5"/>'),
  send: svg('<path d="m4 12 16-7-6 16-3.2-6.6L4 12Z"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  bolt: svg('<path d="M13.5 3 5 13.5h5.5L10 21l8.5-10.5H13L13.5 3Z"/>'),
  link: svg('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.4-1.4"/>'),
  chevron: svg('<path d="m9 5 7 7-7 7"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
  play: svg('<path d="M7 4.5 19 12 7 19.5v-15Z"/>'),
};

export const iconEl = (name, cls = '') => `<span class="ic ${cls}">${icon[name] || ''}</span>`;
