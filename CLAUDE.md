# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hitster is a music guessing game toolkit with two components:
1. **Card Generator (Python)** - Creates printable QR code cards from Spotify playlists
2. **Web Player (JavaScript/Vite)** - Scans QR cards and controls Spotify playback

## Commands

### Python Card Generator

```bash
# Setup (from project root)
virtualenv venv && source venv/bin/activate
pip install -r requirements.txt

# Import a Spotify playlist to CSV
python -m src.main import -p "PLAYLIST_URL" -o playlist.csv \
  --client-id "YOUR_ID" --client-secret "YOUR_SECRET"

# Generate printable PDF cards from CSV
python -m src.main generate -i songs.csv -o output/cards.pdf
```

### Web Player

```bash
cd player
npm install
npm run dev      # Dev server at localhost:5173
npm run build    # Production build to dist/
```

## Architecture

### Python Card Generator (`src/`)

Data flow: Spotify API → CSV → PDF

- `main.py` - CLI entry point with `import` and `generate` subcommands
- `spotify_importer.py` - Fetches playlist tracks via Spotipy, handles pagination
- `csv_parser.py` - Validates CSV, defines `Song` dataclass, converts URLs to `spotify:track:` URIs
- `qr_generator.py` - Creates QR codes (supports inverted white-on-transparent for dark backgrounds)
- `pdf_generator.py` - Generates double-sided A4 PDF with:
  - Front: Black background with concentric broken circles and centered white QR code
  - Back: Starburst design with year/title/artist, decade-based color themes (1950s-2020s)
  - Cards are mirrored on back pages for double-sided printing alignment

### Web Player (`player/src/`)

**Application Flow:**
```
Login Screen → Device Selection → Player (Scanner)
                    │
                    ├── "This Browser" → SDKPlayer (Web Playback SDK, Premium required)
                    └── External Device → ExternalDevicePlayer (Spotify Connect, Premium required)
```

**Core Files:**
- `main.js` - Application state, screen flow (login → device selection → scanning)
- `auth.js` - Spotify OAuth 2.0 with PKCE flow, token storage in localStorage
- `scanner.js` - `QRScanner` class using html5-qrcode + jsQR for both normal and inverted QR codes
- `ui.js` - DOM manipulation utilities, toast notifications

**Playback Engine Architecture (Strategy Pattern):**
- `playback-engine.js` - Abstract base class defining PlaybackEngine interface
- `sdk-player.js` - Spotify Web Playback SDK for full tracks in browser (Premium required)
- `external-device-player.js` - Spotify Connect for external device playback (Premium required)
- `player-factory.js` - Factory for creating engines: `PlayerFactory.create('sdk'|'external')`

**Key Design Decisions:**
1. **Dual Scanning:** The scanner uses html5-qrcode for normal QR codes, plus jsQR with `inversionAttempts: 'attemptBoth'` to handle white-on-black inverted QR codes
2. **Strategy Pattern:** Playback engines share a common interface allowing seamless switching between modes
3. **Spotify Premium Required:** Full track playback requires Spotify Premium. Preview mode was removed due to Spotify API regional restrictions on preview URLs.

## CSV Format

```csv
title,artist,year,spotify_url,preview_url
Bohemian Rhapsody,Queen,1975,https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv,https://p.scdn.co/mp3-preview/...
```

**Note:** The `preview_url` column is optional for backward compatibility. If missing, the web player will attempt to fetch preview URLs from the Spotify API. Preview URLs may be empty for some tracks (~10% have no preview available).

## Spotify Setup

Both components need Spotify Developer credentials from https://developer.spotify.com/dashboard

- **Card Generator:** Set `SPOTIPY_CLIENT_ID` and `SPOTIPY_CLIENT_SECRET` env vars
- **Web Player:** Update `CLIENT_ID` in `player/src/auth.js`, add redirect URI `http://localhost:5173/callback` (requires Premium for playback)

## Card Specifications

- Size: 2.5" x 2.5" (square cards)
- Layout: A4 pages with crop marks
- Print: Double-sided, flip on short edge
- Decade color themes defined in `DECADE_THEMES` dict in `pdf_generator.py`

## TODOs

### High Priority

- [ ] **Add `spotipy` to requirements.txt** - Currently missing, causes confusing errors when running `import` command
- [ ] **Move Spotify Client ID to environment variable** - Hardcoded in `player/src/auth.js:14`, use `import.meta.env.VITE_SPOTIFY_CLIENT_ID`
- [ ] **Add null checks in ui.js:122-124** - `updateNowPlaying()` can throw if DOM elements missing
- [ ] **Escape `device.id` in ui.js:57** - Potential XSS, `device.name` is escaped but `device.id` is not
- [ ] **Add `.env.example` file** - Document required environment variables for new developers

### Medium Priority

- [ ] **Add unit tests for CSV parser** - Test edge cases: unicode, empty fields, malformed URLs, invalid years
- [ ] **Add unit tests for QR generation** - Verify URI encoding and image output
- [ ] **Add unit tests for playback engines** - Test SDKPlayer, ExternalDevicePlayer
- [ ] **Fix pagination logic in spotify_importer.py:98-148** - Can break early if `items` is empty but more tracks exist
- [ ] **Remove unused `BytesIO` import in qr_generator.py:6**
- [ ] **Remove dead code in ui.js:58** - Empty template literal `${device.is_active ? '' : ''}`
- [ ] **Move hardcoded domain from vite.config.js:7** - `allowedHosts` should use env variable

### Low Priority / Nice to Have

- [ ] **Add shuffle command to CLI** - Users currently shuffle CSV manually
- [ ] **Add retry logic for Spotify API calls** - Handle transient 5xx errors and rate limits in playback engines
- [ ] **Extract magic numbers in pdf_generator.py** - Font sizes, radii, spacing should be named constants
- [ ] **Fix race condition in main.js:668-703** - Rapid QR scans can show wrong track info
- [ ] **Improve event listener cleanup in main.js** - Replace cloneNode pattern with AbortController
- [ ] **Add JSDoc types** - Document params/returns for playback engine methods
- [ ] **Standardize Python error message format** - Some include "Error:" prefix, others don't
- [ ] **Handle autoplay restrictions** - Show "tap to play" overlay when browsers block autoplay

### Architecture Considerations (Future)

- [ ] Consider simple state management pattern for web player (currently uses module-level variables)
- [ ] Consider splitting pdf_generator.py into layout, design, and theme modules
- [ ] Consider adding service worker for PWA offline asset caching
- [ ] Consider adding digital game mode with random song selection (PlaybackEngine architecture supports this)
