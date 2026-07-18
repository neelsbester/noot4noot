# Noot4Noot Multiplayer

The primary product is a private, invite-only music timeline game for one host
and 2–8 teams. The production implementation is a Cloudflare Worker with one
Durable Object per room, a small directory Durable Object, static browser
assets, WebSocket revision notifications, and Spotify playback in the original
host browser.

- [PRODUCT_SPEC.md](PRODUCT_SPEC.md) is the agreed product contract.
- [ARCHITECTURE.md](ARCHITECTURE.md) describes boundaries and security rules.
- The older Python service and server remain local reference implementations.

## Local development

From this directory:

```bash
npm ci
npm run check
npm run dev
```

The local Worker is available at `http://127.0.0.1:5173`. Local owner routes
accept the `X-Noot4Noot-Admin-Email` test header; deployed environments require
a valid signed Cloudflare Access application token.

To exercise the actual host and team screens in three isolated portrait browser
contexts:

```bash
../.venv/bin/python ../scripts/test_three_phone_lab.py
```

The smoke test creates an invite, creates and joins a room through the browser,
readies both teams, and covers:

- host-controlled Spotify playback with the external Spotify APIs mocked;
- placement, pass, automatic reveal, and next round;
- turn-start card purchase and a paid song replacement;
- contest placement and automatic reveal;
- delegated host controls without playback metadata;
- owner invite creation;
- 390×844 layout width and browser-console errors.

Spotify login itself remains interactive and requires Spotify Premium.

## One-window test lab

Open `http://127.0.0.1:5173/test-lab` locally or
`https://staging.noot4noot.bestermedia.me/test-lab` on staging. The lab is
owner-only on staging and unavailable in production.

`New test room` creates one host plus Needle Crew and Bassline Club with three
separate HttpOnly seat cookies. The embedded frames are exact 390×844 browser
viewports. `Ready both + start` is a convenience for reaching round one; every
normal host and team control remains directly interactive inside its frame.
The embedded host uses silent simulated playback so placement, contest, token,
and reveal mechanics can be tested without Spotify. `Open full host` uses the
same host seat in a normal tab for real Spotify testing.

CI exercises the lab itself with:

```bash
../.venv/bin/python ../scripts/test_lab_interface.py
```

## Commands

```bash
npm run check                 # generated bindings, types, lint, Worker tests
npm run build                 # production-format dry run
npm run dev                   # local Worker on port 5173
npm run deploy:staging        # staging only
npm run deploy:production     # never run without explicit owner approval
```

The Worker tests cover the pure game state machine, SQLite persistence,
role-scoped secrecy, idempotency, concurrent mutations, invite caps, expiry,
WebSocket upgrades, security headers, signed Access JWTs, and the HTTP
create/join flow.

## Spotify

Spotify uses Authorization Code with PKCE entirely in the playback browser.
The registered callbacks are:

```text
http://127.0.0.1:5173/callback
https://staging.noot4noot.bestermedia.me/callback
https://noot4noot.bestermedia.me/callback
```

Only the original room creator receives the current hidden Spotify URI. Team
devices may open controller mode, but Spotify remains on the original host.
The host manually starts every new or replacement song. Reveal does not pause
the current track; next round and replacement transitions do.

## Environments

- Local: `http://127.0.0.1:5173`
- Staging: `https://staging.noot4noot.bestermedia.me`
- Production: `https://noot4noot.bestermedia.me`

Staging is protected as a whole by Cloudflare Access. Production deployment is
manual; only the owner console will be protected by Access, while players enter
through revocable group invite links.

Pushes and pull requests run verification. A push to `main` may deploy staging
after checks pass. Production is a separate manual workflow and requires the
owner’s explicit approval.

The first staging deployment was completed on 2026-07-18. The account-level
Workers namespace is `neelsbester.workers.dev`, but `workers_dev` and preview
URLs are disabled for this game; use the Access-protected custom domain above.
After deployment, CI authenticates with one exact staging-only Access service
token and verifies invite creation, persistence, and cleanup against the
hosted Worker. Cloudflare Bot Fight Mode challenges GitHub-hosted browser
runners, so the full protected three-phone browser flow runs from the
development VM with `scripts/test_three_phone_lab.py --url` after deployment.
The Worker rejects that automation identity in production. Its credentials are
stored only as `NOOT4NOOT_ACCESS_CLIENT_ID` and
`NOOT4NOOT_ACCESS_CLIENT_SECRET` in the GitHub `staging` environment. The
current token expires on 2027-07-18 and should be rotated before then.

## Legacy reference

The Python `service.py`/`server.py`, legacy scanner in `player/`, and card
generator in `src/` are retained only as references. New game rules belong in
`src/domain/game.ts` with Worker-runtime tests.
