# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

The primary product is the standalone multiplayer music timeline game in
`digital_game/`. One browser hosts a room and 2–8 teams join from phones or
tablets. The server owns all game rules and hidden information; Spotify
playback runs in whichever browser is acting as host.

The older card generator in `src/` and QR scanner in `player/` are retained as
reference implementations. Do not expand them unless the user explicitly
asks. `voice_lab/` is an isolated speech-answer experiment that may inform a
future multiplayer feature but is not integrated.

## Repository Map

```text
digital_game/
  server.py                Standard-library HTTP/JSON and static-file server
  service.py               Authoritative rooms, rules, persistence, serialization
  web/
    host.html / host.js    Host and delegated-host experience
    team.html / team.js    Team placement and challenge experience
    shared.js              API, session, timeline, and reveal helpers
    spotify.js             Spotify OAuth PKCE and Connect requests
    spotify-browser-player.js  Web Playback SDK adapter
    test-lab.*             Host plus two isolated team sessions for local QA
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
.venv/bin/python -m pytest tests/ voice_lab/tests -q
.venv/bin/python -m pytest tests/test_digital_game.py -q
.venv/bin/python -m digital_game.server
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

The multiplayer server currently reads Spotify configuration from
`player/.env`:

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
https://YOUR-TUNNEL.trycloudflare.com/callback
```

The callback must exactly match the host origin. Use HTTPS for phone testing.
Spotify sessions remain local to the browser handling playback.

Playback requires Spotify Premium.

## Multiplayer Development Rules

- Put rule changes in `digital_game/service.py` first and cover every new
  action or phase transition with a service-level test.
- Keep hidden song metadata server-side until reveal. Serialize only the
  minimum state each role needs.
- Preserve opaque host/team tokens and scoped delegated-host authorization.
- State mutations must remain lock-protected and atomically persisted.
- Use the `seat` query parameter for same-origin multi-session test tooling.
- Keep the 700ms polling model until smoother synchronization is a measured
  need; WebSockets or SSE are not prerequisite housekeeping.
- Test portrait phone layouts as well as wider host/tablet layouts.

## Security Notes

- Do not commit `.env`, room state, tokens, generated reports/PDFs, logs, or
  voice benchmark artifacts.
- Use `textContent` or `escapeHtml()` for user-controlled names and metadata.
- Spotify tokens are in browser storage, so avoid expanding the XSS surface.
- The current trusted-room model is not hardened public identity. Before a
  public launch, add room expiry, attempt throttling, rate limiting, and
  production security headers.

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
- Three-phone multiplayer browser smoke test: passing.
- Player tests: 40 passing.
- Vite production build: passing.
- npm audit: 0 reported vulnerabilities.

## Open Improvements

- Add room teardown and expiry.
- Improve Spotify diagnostics and iOS autoplay recovery.
- Add browser unit coverage for shared timeline and reveal helpers.
- Decide whether challenge windows need an optional host timer.
- Choose and implement a stable multiplayer deployment target.
