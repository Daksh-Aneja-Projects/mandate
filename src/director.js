/**
 * The recording script, and a cue system that follows the desk. Open the desk in
 * one window and this in another; as the agent calls tools, this advances on its
 * own, so the take never waits on someone clicking.
 */
const BEATS = [
  {
    at: 0, title: 'The desk',
    say: 'This is Mandate. It is a bank payment operations desk, and there is an AI agent connected to this page through <em>WebMCP</em>. Fifteen payments waiting, SEPA closes in six hours. Watch what the agent can do, and more importantly what it cannot.',
    doThis: 'Have the desk on screen. Point at the queue, the rails counting down, and the "Agent interface live, 18 tools" chip in the header.',
    watch: 'Keep this short. Fourteen seconds, then move.',
  },
  {
    at: 14, title: 'It reads the desk',
    say: 'It reads the desk through structured tools rather than guessing at the page, and every answer comes back as a sentence a person can act on, not a status code.',
    prompt: 'Look at this payment desk and tell me what is blocking the run.',
    watch: 'Agent activity lights up on the right. It should surface the <b>sanctions match on Volkov Trading</b>, the <b>unverified beneficiary</b>, and the <b>payment on a rail that cannot carry its currency</b>.',
    advanceOn: ['explain_hold', 'search_payments', 'get_desk_status'],
  },
  {
    at: 40, title: 'It reaches into another company',
    say: 'That sanctions match is not for this bank to judge. It belongs to a screening bureau, which is a different company on a different origin. The bureau publishes one tool to this desk and keeps its watchlist. So the agent asks the desk, the desk asks the bureau, and the answer comes back attributed and logged. Two organisations on one decision, and neither hands over its data.',
    prompt: 'Re-check that sanctions match with the screening bureau.',
    watch: 'The reply is explicitly <b>from the other origin</b>. Say the words "different company, different origin" out loud, this is the part nobody else will have built.',
    advanceOn: ['recheck_screening_with_bureau'],
  },
  {
    at: 62, title: 'It hits the wall',
    say: 'Here is the part that matters. It cannot. The page refuses, and the refusal is not a four-oh-three, it is coaching: here are the routes forward.',
    prompt: 'Release the five clean SEPA payments.',
    watch: 'A refusal: <b>segregation of duties</b>, an agent cannot authorise a payment on its own authority. Read the named routes out loud.',
    advanceOn: ['release_payment'],
  },
  {
    at: 84, title: 'It asks for authority',
    say: 'So it asks me for a mandate. I set the ceiling, the budget, and when it expires. I can tighten any of it before I agree. And the moment I grant it, the page re-registers its tools: a tool that did not exist a second ago now does.',
    prompt: 'Then ask me for the authority you need to clear them.',
    doThis: 'The mandate card slides up. Tighten the per-payment ceiling, shorten the expiry, then Grant mandate. Switch to the Authority tab and point at release_under_mandate appearing, 18 tools becoming 20.',
    watch: 'The card is <b>editable before you agree</b>. That is the whole argument: the human holds the pen.',
    advanceOn: ['mandate-granted'],
  },
  {
    at: 122, title: 'It works inside the boundary',
    say: 'Five payments cleared in a single call. Everything outside the mandate it left alone, and told me exactly why it left each one.',
    prompt: 'Now clear everything you are allowed to.',
    watch: 'Five rows flip to released. The rest come back with reasons: <b>above the ceiling</b>, <b>unverified beneficiary</b>, <b>sanctions match</b>, and one it could not touch because <b>a mandate does not carry across currencies</b>.',
    advanceOn: ['release_under_mandate'],
  },
  {
    at: 150, title: 'I take it back',
    say: 'I take the authority back, and the tool disappears from the agent mid-session. Everything it did is on the audit trail in plain English, and every bit of it is reversible. That is the idea. WebMCP lets the page be the authority boundary, so an agent can finally be useful inside a system where getting it wrong moves real money.',
    doThis: 'Click Revoke now. Show the Authority tab dropping back to 18 tools. Then the Audit trail tab. End on the trail.',
    watch: 'Close on the audit trail. Do not rush this line.',
    advanceOn: ['mandate-revoked'],
  },
];

const $ = (id) => document.getElementById(id);
let i = 0, t0 = null, running = false;

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function renderBeats() {
  $('beats').innerHTML = BEATS.map((b, n) => `
    <button class="beat-item ${n === i ? 'is-on' : ''} ${n < i ? 'is-done' : ''}" data-n="${n}">
      <span class="n">${n}</span><span class="t">${b.title}</span><span class="at">${mmss(b.at)}</span>
    </button>`).join('');
}

function renderStage() {
  const b = BEATS[i];
  $('stage').innerHTML = `
    <div>
      <div class="kicker">Beat ${i} of ${BEATS.length - 1} &middot; from ${mmss(b.at)}</div>
      <h2>${b.title}</h2>
    </div>
    <div class="block"><div class="lbl">Say this</div><p class="say">${b.say}</p></div>
    ${b.prompt ? `<div class="block"><div class="lbl">Type this to the agent</div>
      <div class="prompt-row"><p class="prompt" id="promptText">${b.prompt}</p>
      <button class="btn btn-sm" id="copyBtn">Copy</button></div></div>` : ''}
    ${b.doThis ? `<div class="block"><div class="lbl">Do this</div><p class="do">${b.doThis}</p></div>` : ''}
    <div class="block"><div class="lbl">Watch for</div><p class="watch">${b.watch}</p></div>`;

  const c = $('copyBtn');
  if (c) c.onclick = copyPrompt;
  renderBeats();
}

function copyPrompt() {
  const p = BEATS[i].prompt;
  if (!p) return;
  navigator.clipboard.writeText(p).then(() => {
    const c = $('copyBtn');
    if (c) { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); }
  }, () => { /* clipboard blocked; the text is on screen to read anyway */ });
}

const go = (n) => { i = Math.max(0, Math.min(BEATS.length - 1, n)); renderStage(); };

$('next').onclick = () => go(i + 1);
$('prev').onclick = () => go(i - 1);
$('startStop').onclick = () => {
  running = !running;
  if (running && t0 === null) t0 = Date.now();
  if (!running) t0 = null;
  $('startStop').textContent = running ? 'Reset timer' : 'Start timer';
  if (!running) { $('now').textContent = '0:00'; $('timer').classList.remove('is-over'); }
};

addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
  else if (e.key.toLowerCase() === 'c') copyPrompt();
});

$('beats').addEventListener('click', (e) => {
  const b = e.target.closest('.beat-item');
  if (b) go(Number(b.dataset.n));
});

// The desk broadcasts what the agent does. Advance when this beat's cue fires.
try {
  const ch = new BroadcastChannel('mandate-demo');
  let seen = false;
  ch.onmessage = (e) => {
    if (!seen) { seen = true; $('live').classList.add('is-on'); $('liveText').textContent = 'Desk connected'; }
    const cue = e.data?.tool || e.data?.event;
    if (running && BEATS[i].advanceOn?.includes(cue)) setTimeout(() => go(i + 1), 900);
  };
} catch { /* older browser: manual advance still works */ }

setInterval(() => {
  if (!running || t0 === null) return;
  const s = (Date.now() - t0) / 1000;
  $('now').textContent = mmss(s);
  $('timer').classList.toggle('is-over', s > 170);
}, 250);

renderStage();
