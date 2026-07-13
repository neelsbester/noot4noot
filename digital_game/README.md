# Noot4Noot Digital Game

Standalone local multiplayer mode for Noot4Noot. One browser is the host table and each team joins from its own phone or tablet. The game uses digital song cards, server-authoritative timelines, Spotify playback, challenges, passes, and host-managed tokens.

This directory is the July 2026 development checkpoint. See [ARCHITECTURE.md](ARCHITECTURE.md) for the state model, API, visibility rules, and implementation notes.

## Quick start

Run from the repository root in WSL:

```bash
.venv/bin/python -m digital_game.server --quick-tunnel
```

The server prints:

- `http://127.0.0.1:5173` for hosting on the PC.
- A temporary `https://...trycloudflare.com` URL for phones and iPads.

Open the public HTTPS URL on an iPad if the iPad will be the host. Open the same URL on team devices and join with the four-character room code.

Rooms are kept in memory and reset whenever the Python server stops.

## Stable tunnel during development

`--quick-tunnel` starts and stops Cloudflare together with the server, so its hostname changes on every restart. To keep one temporary hostname while reloading the Python server, run Cloudflare separately.

Terminal 1:

```bash
~/.local/bin/cloudflared tunnel --url http://localhost:5173 --no-autoupdate
```

Copy the generated HTTPS URL, then use it in Terminal 2:

```bash
.venv/bin/python -m digital_game.server \
  --public-url https://YOUR-TUNNEL.trycloudflare.com
```

The Cloudflare process can remain running while the Python process is restarted. The URL is still temporary and only lasts while that tunnel process is alive.

For local-only testing:

```bash
.venv/bin/python -m digital_game.server
```

## Spotify setup

The digital host reads `VITE_SPOTIFY_CLIENT_ID` from `player/.env`.

Register the exact callback matching the host origin:

```text
http://127.0.0.1:5173/callback
https://YOUR-TUNNEL.trycloudflare.com/callback
```

Spotify no longer accepts `http://localhost` callbacks. A callback must match exactly, including protocol, hostname, port, path, and trailing slash.

Only the host authenticates. The requested scopes support Spotify Connect and Spotify Web Playback SDK audio. Spotify Premium is required.

After connecting, the host can choose:

- **This browser** to play directly in the host browser, including mobile Safari. iOS may require a second Play tap the first time because audio must be unlocked by a user gesture.
- Any currently available Spotify Connect device.

## Game rules implemented

- One host and 2-8 teams.
- Four-character room codes with browser-session reconnect tokens.
- Each team starts with two tokens and one timeline card.
- The active team places the mystery card and locks its position.
- Rival teams can challenge for one token or choose **No challenge**.
- Only the first team to challenge can place a rival answer.
- In games with more than two teams, the challenge window closes automatically once every rival has passed.
- A correct active placement wins the card. A correct challenge steals the card. If neither answer is correct, the card returns to the deck flow without a winner.
- The host awards one token when a team gets both title and artist correct.
- The host can spend three team tokens to add a random card to that team's timeline.
- Tokens are clamped between zero and five.
- The first team to ten cards wins by default.

## Visual behavior

- Cards are coloured consistently by release decade, from the 1950s through the 2020s.
- The active card is dragged or tapped into a timeline gap and explicitly locked.
- Correct reveals expand into the chosen gap and pulse with a green confirmation.
- Incorrect reveals leave red wrong-position markers while the revealed card travels to the server-calculated correct gap.
- The result banner waits until the placement explanation animation finishes.
- The pre-reveal timeline remains visible during this animation; won cards become permanent on the following round.

## Useful options

```bash
.venv/bin/python -m digital_game.server --help
.venv/bin/python -m digital_game.server --deck songs.csv
.venv/bin/python -m digital_game.server --starting-tokens 2 --target-cards 10
.venv/bin/python -m digital_game.server --public-url https://example.test
```

`white_people_turnt_shuffled.csv` is the default deck when present. Otherwise the server uses `songs.csv`.

## Verification

Run the focused tests:

```bash
.venv/bin/python -m pytest tests/test_digital_game.py -q -s
```

Run the full Python suite:

```bash
.venv/bin/python -m pytest tests/ -q -s
```

Checkpoint baseline:

- Digital game tests: 10 passing.
- Full Python suite: 82 passing, with one existing ReportLab deprecation warning.
- Host and team JavaScript modules parse successfully.
- Correct and incorrect reveal states were exercised in headless Chromium at 1024x600 landscape with no page errors.
- The local three-phone test lab creates isolated host/team sessions and quick-starts a live placement round.

## Current limitations and next steps

1. Deploy this multiplayer app behind a stable hostname. `noot4noot.bestermedia.me` still serves the earlier card-scanner player at this checkpoint.
2. Persist rooms and sessions so a Python restart does not clear an active game.
3. Replace 700ms polling with WebSockets or server-sent events if smoother synchronization becomes important.
4. Add a host recovery flow and explicit room teardown.
5. Improve Spotify connection diagnostics for expired scopes, unavailable devices, and iOS autoplay failures.
6. Add JavaScript unit coverage for decade mapping, reveal markup, browser-player state, and test-lab helpers.
7. Decide whether challenge windows need an optional host-configured timer.

For local multi-device QA, open `http://127.0.0.1:5173/test-lab`. It presents one host and two isolated team sessions in landscape phone frames and can create and quick-start a disposable room.

The original interactive design mockup is retained under `mockups/digital-game/` as a visual reference. The live implementation is under `digital_game/web/`.
