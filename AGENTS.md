# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

The primary product is the standalone multiplayer music timeline game in
`digital_game/`. One browser hosts a room and 2–8 teams join from phones or
tablets. The Worker owns all game rules and hidden information; Spotify
playback stays in the original room-creator browser.

The older card generator in `src/` and QR scanner in `player/` are retained as
reference implementations. Do not expand them unless the user explicitly
asks. `voice_lab/` is an isolated speech-answer experiment that may inform a
future multiplayer feature but is not integrated.

## Repository Map

```text
digital_game/
  src/
    domain/game.ts         Authoritative game state machine
    durable/               Directory and per-room Durable Objects
    router.ts              Worker HTTP, asset, security, and WebSocket boundary
  wrangler.jsonc           Local, staging, and production configuration
  server.py / service.py   Legacy Python reference checkpoint
  web/
    host.html / host.js    Host and delegated-host experience
    team.html / team.js    Team placement and challenge experience
    shared.js              API, session, timeline, and reveal helpers
    spotify.js             Spotify OAuth PKCE and Connect requests
    spotify-browser-player.js  Web Playback SDK adapter
  README.md                Developer runbook and current limitations
  ARCHITECTURE.md          State model, API, visibility, and design rules

tests/test_digital_game.py  Service, rule, persistence, secrecy, and HTTP tests
scripts/test_three_phone_lab.py  Headless multiplayer browser smoke test
voice_lab/                 Isolated voice-answer experiment
player/                    Legacy QR scanner reference
src/                       Legacy card-generator reference
mockups/digital-game/      Original interactive design reference
```

## Commands

Set up and verify from the repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m playwright install chromium
cd digital_game
npm ci
npm run check
npm run build
npm run dev
```

With the server running, exercise the browser flow:

```bash
.venv/bin/python scripts/test_three_phone_lab.py
```

The legacy player verification remains available when changes overlap it:

```bash
cd player
npm ci
npm test
npm run build
```

## Environment

The Worker reads environment-specific Spotify and Access configuration from
`digital_game/wrangler.jsonc`. Local legacy tools may still read `player/.env`:

```env
VITE_SPOTIFY_CLIENT_ID=...
VITE_ALLOWED_HOSTS=localhost,127.0.0.1,noot4noot.bestermedia.me
```

`VITE_SPOTIFY_CLIENT_ID` is required. There is no hardcoded fallback.

## Spotify Setup

Create a Spotify Developer app at `https://developer.spotify.com/dashboard`.

Redirect URIs depend on how the multiplayer host is opened:

```text
http://127.0.0.1:5173/callback
https://staging.noot4noot.bestermedia.me/callback
https://noot4noot.bestermedia.me/callback
```

The callback must exactly match the host origin. Use HTTPS for phone testing.
Spotify sessions remain local to the browser handling playback.

Playback requires Spotify Premium.

## Multiplayer Development Rules

- Put rule changes in `digital_game/src/domain/game.ts` first and cover every
  action or phase transition with a state-machine test.
- Keep hidden song metadata server-side until reveal. Serialize only the
  minimum state each role needs.
- Preserve opaque host/team tokens and scoped delegated-host authorization.
- State mutations must remain lock-protected and atomically persisted.
- Keep WebSockets limited to revision notifications and preserve the 700ms
  polling fallback.
- Test portrait phone layouts as well as wider host/tablet layouts.

## Security Notes

- Do not commit `.env`, room state, tokens, generated reports/PDFs, logs, or
  voice benchmark artifacts.
- Use `textContent` or `escapeHtml()` for user-controlled names and metadata.
- Spotify tokens are in browser storage, so avoid expanding the XSS surface.
- The invite gate is designed for trusted private groups, not public identity.
  Preserve room expiry, attempt throttling, rate limiting, signed Access JWT
  validation, and production security headers.

## Generated Files

Ignored/generated files include:

- `output/*.pdf`
- `output/*_report.txt`
- `player/dist/`
- `node_modules/`
- `__pycache__/` and `*.pyc`
- `.pytest_cache/`
- `.env`
- `digital_game/.data/`
- `voice_lab/benchmark_artifacts/`
- local `.bridgespace/` and `.claude/` configuration

The large playlist CSVs currently in the repo are working input data. Do not delete or rewrite them unless the user asks.

## Current Verification Baseline

- Python tests: 102 passing across `tests/` and `voice_lab/tests`.
- Focused multiplayer tests: 17 passing.
- Worker/game tests: 31 passing.
- Three-phone multiplayer browser smoke test: passing through purchase,
  playback/resume/replacement, placement, pass/contest, delegated controls,
  callback recovery, and admin invite creation.
- One-window test-lab browser smoke: passing through isolated seat
  provisioning, quick start, simulated playback, placement, pass, and reveal.
- Staging: deployed from `main` and gated by the owner-only Cloudflare Access
  application at `https://staging.noot4noot.bestermedia.me`; a separate exact
  service identity runs the post-deploy API smoke and is rejected outside
  staging.
- Player tests: 40 passing.
- Vite production build: passing.
- npm audit: 0 reported vulnerabilities.

## Open Improvements

- Verify Spotify OAuth and real Premium playback on staging hardware.
- Add isolated browser tests for delayed response races and token-exchange
  failure.
- Add production Access applications before the first production deployment.
- Decide whether voice answers should graduate from `voice_lab/`.
