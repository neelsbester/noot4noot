# Noot4Noot Digital Game

Standalone local multiplayer mode for Noot4Noot. One browser starts as the host table and each team joins from its own phone or tablet. A team can temporarily switch to scoped host controls after entering the host's one-time control code, so hosting duties can move around the room without exposing the original host token. The game uses digital song cards, server-authoritative timelines, Spotify playback, challenges, passes, and host-managed tokens.

This directory is the July 2026 development checkpoint. See [ARCHITECTURE.md](ARCHITECTURE.md) for the state model, API, visibility rules, and implementation notes.

## Quick start

Run from the repository root in the Linux VM:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m playwright install chromium
```

Then start the game:

```bash
.venv/bin/python -m digital_game.server --quick-tunnel
```

The server prints:

- `http://127.0.0.1:5173` for hosting on the PC.
- A temporary `https://...trycloudflare.com` URL for phones and iPads.

Open the public HTTPS URL on an iPad if the iPad will be the host. Open the same URL on team devices and join with the four-character room code.

Rooms are saved to `digital_game/.data/rooms.json` after every change and restored when the Python server restarts. Browser session tokens remain valid after recovery.

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

A device only needs Spotify authentication while it is handling playback. Spotify sessions remain local to that browser, including when a team switches into host mode. The requested scopes support Spotify Connect and Spotify Web Playback SDK audio. Spotify Premium is required.

After connecting, the host can choose:

- **This browser** to play directly in the host browser, including mobile Safari. iOS may require a second Play tap the first time because audio must be unlocked by a user gesture.
- Any currently available Spotify Connect device.

## Game rules implemented

- One host and 2-8 teams.
- Four-character room codes with browser-session reconnect tokens.
- Every team header has a **Host** switch. The first switch requires the four-digit control code shown only on the host screen. Once authorized, that team session can use scoped host actions without receiving the room's original host token; **Team view** returns to its normal private screen.
- Each team starts with two tokens and one timeline card.
- The active team places the mystery card and locks its position.
- Rival teams can challenge for one token or choose **No challenge**.
- Only the first team to challenge can place a rival answer.
- In games with more than two teams, the challenge window closes automatically once every rival has passed.
- A correct active placement wins the card. A correct challenge steals the card. If neither answer is correct, the card is discarded for that game.
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
.venv/bin/python -m digital_game.server --state-file /path/to/rooms.json
```

`white_people_turnt_shuffled.csv` is the default deck when present. Otherwise the server uses `songs.csv`.

## Verification

Run the focused tests:

```bash
.venv/bin/python -m pytest tests/test_digital_game.py -q -s
```

Run the full Python suite, including the adjacent voice experiment:

```bash
.venv/bin/python -m pytest tests/ voice_lab/tests -q
```

Checkpoint baseline:

- Digital game tests: 17 passing.
- Full Python suite: 102 passing, with one existing ReportLab deprecation warning.
- Host and team JavaScript modules parse successfully.
- The three-phone headless Chromium smoke flow passes at 390x844 per device.
- The smoke flow covers room creation, Spotify playback command mocking,
  placement, song skipping, reveal, and correct-placement animation.

## Current limitations and next steps

1. Choose a stable deployment target; `noot4noot.bestermedia.me` still serves
   the earlier card-scanner player at this checkpoint.
2. Add explicit room teardown and expiry for abandoned persisted rooms.
3. Improve Spotify diagnostics for expired scopes, unavailable devices, and
   iOS autoplay failures.
4. Add JavaScript unit coverage for decade mapping, reveal markup,
   browser-player state, and test-lab helpers.
5. Decide whether challenge windows need an optional host-configured timer.
6. Replace polling with WebSockets or server-sent events only if measured
   multiplayer synchronization warrants the added complexity.

For local multi-device QA, open `http://127.0.0.1:5173/test-lab`. It presents one host and two isolated team sessions in portrait phone frames and can create and quick-start a disposable room.

With the server running, execute the reusable browser smoke test with:

```bash
.venv/bin/python scripts/test_three_phone_lab.py
```

It drives placement, lock-in, no-challenge, reveal, and the correct-placement animation across all three phone frames. Spotify authorization remains interactive and is intentionally outside this smoke test.

The original interactive design mockup is retained under `mockups/digital-game/` as a visual reference. The live implementation is under `digital_game/web/`.
