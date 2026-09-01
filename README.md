# Mandate

**Scoped, supervised, revocable authority for agents — built on [WebMCP](https://github.com/webmachinelearning/webmcp).**

Agents are locked out of nearly every high-consequence system on earth. Not because
they lack capability, but because those systems have no way to grant an agent
*partial* authority: enough to be useful, bounded enough to be safe, and revocable
the instant a human changes their mind.

WebMCP moves the tool boundary into the page. That means the page — not the model,
not the model's vendor — can be the authority boundary. Mandate is what that looks
like on a bank's payment operations desk, where getting it wrong moves real money.

> **Status: in active development** for the [WebMCP Challenge](https://webmcp.devpost.com/).
> This README is updated as the build lands. The control engine (`src/controls.js`)
> is complete and covered by tests.

## The idea

An agent connected to Mandate can investigate the payment queue freely. It cannot
move money. To do anything consequential it must either route the payment to a
person, or **negotiate a mandate**: it asks a human for bounded authority
("release payments under €5,000 to already-verified beneficiaries on SEPA, for the
next two hours, up to €50,000 total"). The human grants it in the page, with scope
they control. The page then *re-registers its tool surface* — new tools appear
because authority now exists — and revokes them the moment the mandate is
withdrawn or expires.

## Running it

```bash
node --test     # control engine tests
```

Requires Chromium 146+ with `chrome://flags/#enable-webmcp-testing` enabled, or
ChatGPT's in-app browser, which supports WebMCP natively. There is no build step
and no server dependency: the app is static files and all state is client-side.

## License

MIT — see [LICENSE](LICENSE).
