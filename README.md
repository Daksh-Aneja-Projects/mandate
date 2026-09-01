# Mandate

**Scoped, supervised, revocable authority for AI agents — built on [WebMCP](https://github.com/webmachinelearning/webmcp).**

**Live: https://mandate-webmcp.vercel.app**

Open it in ChatGPT's in-app browser, or in Chromium 146+ with
`chrome://flags/#enable-webmcp-testing` enabled. No sign-in, no setup, no keys.

---

## The problem

Agents are locked out of nearly every high-consequence system on earth. Not for
lack of capability — a model can read a payment queue and spot the duplicate
faster than a person can. They are locked out because those systems have no way
to grant an agent *partial* authority: enough to be useful, bounded enough to be
safe, and revocable the instant a human changes their mind.

Today the choice is binary. Either the agent gets your credentials and can do
everything you can do, or it gets nothing. Every bank, hospital and factory
picks nothing, and rationally so.

WebMCP changes where that decision can live. Because tools are defined **by the
page, in the page**, the site itself — not the model, not the model's vendor —
decides what an agent may do, under what conditions, and for how long. The page
becomes the authority boundary.

Mandate is what that looks like on a bank's payment operations desk, where
getting it wrong moves real money.

## What people and agents can do together here that they could not before

**An agent can negotiate its own authority, and a person can hand it over
without handing over the keys.** The agent calls `propose_mandate` asking for
what it needs — "up to €5,000 a payment, €50,000 total, SEPA only, verified
beneficiaries only, for the next thirty minutes." The request appears on the
desk as a card the person can **edit before agreeing**: tighten the ceiling,
shorten the clock, refuse outright. When they grant it, the page re-registers
its tool surface and a tool that did not exist a second ago now does. When they
revoke it, that tool is gone from the agent's list mid-session.

That loop — an agent asking for authority, a human shaping it, and the *tool
surface itself* changing as a result — is not possible with a conventional MCP
server. A server hands out a fixed tool list to a client it cannot see. Only a
page that is simultaneously the agent's interface and the human's interface can
put a person inside the decision.

Three more things fall out of the same property:

- **A refusal is a conversation, not a 403.** When the agent tries to release a
  payment it has no authority for, it does not get an error code. It gets:
  *"Segregation of duties. An agent cannot authorise a payment on its own
  authority"* — plus the two named tools that would work instead. The agent
  reroutes itself.
- **The human is inside the tool call, not notified after it.**
  `request_authorization` returns a promise the page resolves only when someone
  clicks. The agent is genuinely blocked, and when it unblocks it has the actual
  human answer, including anything they typed back.
- **Nothing leaves the tab.** All desk state is client-side. A bank could put
  real positions behind this and the agent would operate on data that never
  reaches a third party — because the tools execute in the page, not on someone
  else's server.

## How WebMCP is implemented

### Imperative API — a tool surface computed from state

The entire surface is rebuilt from current state and re-registered whenever
anything changes. This is what makes the mandate real rather than cosmetic:
tools are not registered once and then made to refuse, they genuinely do not
exist until authority does.

```js
document.modelContext.registerTool({
  name: 'release_under_mandate',
  description: 'Release every payment that falls inside the mandate you currently hold, in one pass. Anything outside the mandate is left alone and reported back to you with the reason, so you can route those to a person.',
  inputSchema: {
    type: 'object',
    properties: {
      dryRun: { type: 'boolean', description: 'If true, report what would be released without releasing anything. Worth doing first.' },
      maxPayments: { type: 'number', description: 'Optional ceiling on how many to release in this pass.' },
    },
  },
  execute: async ({ dryRun = false, maxPayments }) => { /* ... */ },
}, { signal: controller.signal });
```

Registration is scoped to an `AbortSignal` held by the current surface. Granting
or revoking a mandate, or a different person taking the desk, aborts the old
controller and registers the new set — which fires `toolchange` for the agent.
See [`src/tools.js`](src/tools.js).

### Declarative API — a form is a tool, and it can hold the agent open

```html
<form toolname="ask_the_desk"
      tooldescription="Put a question in front of whoever is at the desk right now and wait for their written answer.">
  <input type="text" name="question"
         toolparamdescription="The question to put to the person at the desk, in plain language.">
</form>
```

```js
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!e.agentInvoked) return;
  e.respondWith(askHuman({ /* ... */ }).then((d) => d.text));  // resolves when a person clicks
});
```

### Everything else the spec offers

| Capability | Where |
|---|---|
| `registerTool` with `annotations.readOnlyHint` | all eight read tools |
| `{ signal }` lifecycle, re-registered on state change | `syncTools()` in `src/tools.js` |
| `toolchange` listener | header tool counter in `src/ui.js` |
| `getTools()` / `executeTool()` | `tools/verify-webmcp.js` |
| Declarative `toolname` / `tooldescription` / `toolparamdescription` | `index.html` |
| `e.agentInvoked` + `e.respondWith(promise)` | `src/ui.js` |
| `toolactivated` event | `src/ui.js` |
| Human confirmation for consequential actions | the approval dock, `askHuman()` |

Chrome's guidance says to accept raw user input rather than making the agent do
arithmetic, so every amount is taken as written (`"4820.00"`) and converted to
integer minor units in one strict parser. No float ever touches an amount.

> **A note on the spec.** The explainer shows `executeTool` taking an arguments
> object; Chrome's imperative API docs describe a JSON string. Against Chrome
> 152 it is a **JSON string**. `tools/verify-webmcp.js` tries both and reports
> which the browser took.

## The tool surface

Nineteen tools in four tiers. The last tier only exists while a person says it
does.

**Read — free rein** (`readOnlyHint: true`)
`get_desk_status` · `get_authority` · `search_payments` · `get_payment` ·
`explain_hold` · `search_beneficiaries` · `get_exposure` · `get_audit_trail`

**Prepare — moves no money**
`draft_payment` · `amend_payment` · `attach_evidence`

**Consequential — blocks on a person**
`request_authorization` · `release_payment` · `ask_the_desk` (declarative)

**Governance — the agent negotiating its own limits**
`propose_mandate` · `get_mandate` · `undo_last_agent_action`

**Only while a mandate is in force**
`release_under_mandate` · `revoke_mandate`

## The controls are real

The demo data is fictional. The controls evaluated against it are not — they are
the ones that actually stop payments on a real desk, in
[`src/controls.js`](src/controls.js), covered by tests:

segregation of duties · four-eyes / maker-checker · per-role single-payment and
daily cumulative authority limits · dual-authorisation thresholds · beneficiary
verification · sanctions screening · available balance net of what the queue has
already pledged · rail eligibility and daily cut-offs · duplicate detection ·
evidence requirements · mandate scope (ceiling, budget, rails, currency,
beneficiary class, expiry)

Some of these were found by the tests rather than designed in. A mandate
originally compared its ceiling against payments in *other currencies*; a
denominated mandate now does not carry across currencies at all.

Every finding is a sentence, not a code, and every refusal names the tools that
would work instead.

## Architecture

**No backend. No database. No AI. No API keys. No build step.**

The visiting agent is the intelligence — ChatGPT's browser or Chrome brings the
model, and the page brings the tools and the governance. That is the whole point
of WebMCP, so shipping an LLM of our own would have missed it. It also means the
app is static files that a judge can open with one click.

```
index.html          the desk
director.html       recording teleprompter, follows the desk over BroadcastChannel
styles.css
src/controls.js     the control engine        (no DOM, no I/O, fully testable)
src/state.js        state, audit trail, undo, the human-in-the-loop gate
src/tools.js        the WebMCP surface
src/ui.js           rendering and live visuals
src/seed.js         the demonstration desk
test/               34 tests, node:test, no framework
tools/verify-webmcp.js   drives real Chrome over CDP and asks what registered
```

## Running it

```bash
npm run serve       # http://localhost:4321, no dependencies
```

```bash
node --test         # 34 tests: control engine and the full tool surface
```

```bash
node tools/verify-webmcp.js https://mandate-webmcp.vercel.app
```

That last one launches Chrome with `--enable-features=WebMCPTesting`, loads the
app, and asks the browser what it registered — including that granting a mandate
takes the surface from 17 tools to 19 and revoking it takes it back to 17.

```
  ok   document.modelContext is present
  ok   the desk registered its tools - 17 tools
  ok   release refuses without a mandate
  ok   granting a mandate adds release_under_mandate - 19 tools now
  ok   revoking removes it again - 17 tools
  12/12 checks passed.
```

## Honesty

- The desk is a demonstration environment and says so on screen. The
  organisation, people, beneficiaries and payments are fictional.
- The desk clock opens at 09:15 and runs forward in real time, so the rail
  cut-offs mean something whatever hour you visit. The header shows it.
- Rail cut-off times are representative desk values, not an authoritative
  schedule. Every desk configures its own.
- Nothing here fabricates a number. Where something cannot be evaluated, the
  control says so rather than passing quietly.

## License

MIT — see [LICENSE](LICENSE).
