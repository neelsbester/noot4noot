# Project Status

Last verified: 2026-07-18

## Product direction

Noot4Noot development is focused on the standalone multiplayer browser game
under `digital_game/`. The card generator (`src/`) and QR scanner (`player/`)
are legacy reference implementations. They should remain buildable, but new
product work belongs in the multiplayer game unless explicitly requested.

`voice_lab/` is a separate OpenAI Realtime speech-answer experiment. It may be
integrated later only after real-device accuracy, latency, cost, and
music-bleed testing.

## Current multiplayer checkpoint

- Host plus 2–8 team sessions.
- Server-authoritative placement, challenge, pass, reveal, and timeline rules.
- Hidden song metadata scoped by viewer role.
- Spotify Connect and in-browser Web Playback SDK paths.
- Delegated host controls authorized by a four-digit room code.
- Atomic file-backed room persistence and session recovery after restart.
- Token awards, random-card purchases, song skipping with challenge refunds,
  target-card wins, and deck-exhaustion finishes.
- Responsive portrait team UI and wider host/tablet layouts.
- Three-phone local test lab and automated Chromium smoke flow.

## Verification baseline

- `102` Python tests pass across `tests/` and `voice_lab/tests`.
- `17` focused multiplayer service/API tests pass.
- The three-phone Chromium smoke flow passes at `390x844` per device.
- The legacy QR player retains `40` passing Vitest tests and a successful Vite
  production build.
- npm reports zero known vulnerabilities.

The only current automated warning is ReportLab's upstream use of
`ast.NameConstant`, which Python has deprecated ahead of Python 3.14.

## Prioritized continuation

1. Run a real-device game with Spotify on iOS and Android and record concrete
   playback, layout, and synchronization issues.
2. Add explicit room teardown and automatic expiry for abandoned persisted
   rooms.
3. Improve actionable Spotify recovery for stale scopes, missing devices, and
   autoplay restrictions.
4. Add browser unit coverage around shared timeline rendering, reveal
   animations, Spotify state, and the test lab.
5. Decide whether challenge windows need an optional host-configured timer.
6. Choose a stable HTTPS deployment and harden the trusted-room boundary with
   throttling, rate limits, session lifecycle rules, and production headers.
7. Replace 700ms polling with SSE or WebSockets only if real play shows that
   polling materially hurts synchronization.

## Operational notes

- The production hostname currently serves the older scanner, not the
  multiplayer game.
- Multiplayer runtime state under `digital_game/.data/` is intentionally
  ignored.
- Spotify client configuration currently lives in ignored `player/.env`.
- Generated decks, reports, PDFs, logs, and voice benchmark results are
  artifacts rather than source.
