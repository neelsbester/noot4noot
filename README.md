# Noot4Noot

Noot4Noot is a multiplayer music timeline game. A host starts a room, teams join
from their phones, Spotify plays a hidden song, and teams place the song into
their timelines before the answer is revealed.

The live product is the standalone browser game under `digital_game/`. The
older QR-card generator and scanner remain in the repository as reference
implementations and are not the primary development target.

## Multiplayer game

The game currently supports:

- One host and 2–8 teams with reconnectable room sessions.
- Server-authoritative timelines, placements, challenges, passes, and reveals.
- Spotify Connect or in-browser Spotify Web Playback SDK audio.
- Delegated host controls from an authorized team device.
- Persisted rooms that survive Python server restarts.
- Token awards, random-card purchases, song skipping, and terminal win states.
- A local three-phone browser lab for repeatable multiplayer QA.

Read [digital_game/README.md](digital_game/README.md) for the runbook and
[digital_game/ARCHITECTURE.md](digital_game/ARCHITECTURE.md) for the state
model, API, visibility rules, and development conventions.

## Quick start

Create the native VM environment:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m playwright install chromium
```

Create `player/.env` from `player/.env.example`, set
`VITE_SPOTIFY_CLIENT_ID`, then start the game:

```bash
.venv/bin/python -m digital_game.server
```

Open `http://127.0.0.1:5173`. Phone testing and Spotify OAuth require an HTTPS
tunnel with its exact `/callback` URL registered in the Spotify Developer
Dashboard. Playback requires Spotify Premium.

## Verification

```bash
.venv/bin/python -m pytest tests/ voice_lab/tests -q

# In another terminal, with the game server running:
.venv/bin/python scripts/test_three_phone_lab.py
```

The July 2026 housekeeping baseline is:

- 102 Python tests passing.
- 17 focused multiplayer service/API tests passing.
- Three-phone headless Chromium smoke flow passing.
- Legacy scanner: 40 Vitest tests and its Vite production build passing.

## Supporting and reference components

- `voice_lab/`: isolated OpenAI Realtime speech-answer experiment. It is not
  integrated into the game.
- `player/`: legacy QR scanner and shared Spotify implementation reference.
- `src/`: legacy Python playlist, CSV, QR, and printable-card tooling.
- `mockups/digital-game/`: original multiplayer design reference.

See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the current checkpoint and
prioritized continuation work.
