# Project Status

Last verified: 2026-07-24

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
- Cloudflare Worker deployment with a SQLite-backed Durable Object per room.
- Server-authoritative placement, challenge, pass, reveal, and timeline rules.
- Hidden song metadata scoped by viewer role.
- Spotify Connect and in-browser Web Playback SDK paths.
- Delegated host controls available from every team device while Spotify stays
  in the original playback browser.
- Atomic room persistence, idempotent mutations, session recovery, explicit
  room closure, and 24-hour inactivity expiry.
- Token awards, random-card purchases, song skipping with challenge refunds,
  target-card wins, and deck-exhaustion finishes.
- Optional 30, 45, or 60-second challenge windows.
- WebSocket revision notifications with a 700ms polling fallback.
- Responsive portrait team UI and wider host/tablet layouts.
- Three-phone local test lab and automated Chromium smoke flow.
- Owner-only one-window test lab with three isolated phone seats and simulated
  playback.
- Access-protected staging deployment with post-deploy API verification.

The current draft checkpoint is
[`agent/checkpoint-role-switch-motion-studies`](https://github.com/neelsbester/noot4noot/pull/2).
It moves team/host role switching into the compact phone status strip and adds
an isolated animation lab. The selected live treatments are Focus rail for
placement, Button sweep for locking, Year flip for reveal, Coloured edge for
earned cards, Initial hand-off for turn changes, and Counter ring for token
changes. All respect the operating system's reduced-motion preference.

## Verification baseline

- `102` Python tests pass across `tests/` and `voice_lab/tests`.
- `31` Worker/game tests pass, including rule, persistence, secrecy, expiry,
  WebSocket, and security coverage.
- The three-phone Chromium smoke flow passes at `390x844` per device through
  purchase, playback/resume/replacement, placement, pass/contest, reveal,
  delegated controls, callback recovery, and owner invite creation.
- The one-window test-lab smoke passes through isolated seat provisioning,
  manual team readiness and host start, simulated playback, placement, pass,
  reveal, compact role switching, all six selected motion transitions, and
  vertical timeline assertions.
- The legacy QR player retains `40` passing Vitest tests and a successful Vite
  production build.
- npm reports zero known vulnerabilities.

The only current automated warning is ReportLab's upstream use of
`ast.NameConstant`, which Python has deprecated ahead of Python 3.14.

## Prioritized continuation

1. Run a real-device game with Spotify Premium on iOS and Android and record
   concrete OAuth, playback, layout, and synchronization issues.
2. Add isolated browser tests for delayed response races and Spotify
   token-exchange failure.
3. Improve actionable Spotify recovery for stale sessions or scopes, missing
   devices, and autoplay restrictions.
4. Configure production Cloudflare Access applications and complete an
   explicitly approved production rollout.
5. Decide whether voice answers should graduate from `voice_lab/`.

## Operational notes

- Staging serves the multiplayer game behind owner-only Cloudflare Access.
- The production hostname still serves the older scanner; production
  multiplayer deployment requires explicit owner approval.
- Multiplayer runtime state under `digital_game/.data/` is intentionally
  ignored.
- Worker Spotify and Access configuration is environment-specific in
  `digital_game/wrangler.jsonc`; secrets remain outside the repository.
- The staging automation service token expires on 2027-07-18 and should be
  rotated before then.
- Generated decks, reports, PDFs, logs, and voice benchmark results are
  artifacts rather than source.
