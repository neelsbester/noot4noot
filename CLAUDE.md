# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Noot4Noot is a music guessing game toolkit with two components:
1. **Card Generator (Python)** - Creates printable QR code cards from Spotify playlists
2. **Web Player (JavaScript/Vite)** - Scans QR cards and controls Spotify playback

## Commands

### Python Card Generator

```bash
# Setup (from project root)
virtualenv venv && source venv/bin/activate
pip install -r requirements.txt

# Import a Spotify playlist to CSV
python -m src import -p "PLAYLIST_URL" -o playlist.csv \
  --client-id "YOUR_ID" --client-secret "YOUR_SECRET"

# Generate printable PDF cards from CSV
python -m src generate -i songs.csv -o output/cards.pdf

# Run Python tests
python -m pytest tests/ -v
```

### Web Player

```bash
cd player
npm install
npm run dev      # Dev server at localhost:5173
npm run build    # Production build to dist/
npm test         # Run vitest
```

## Architecture

### Python Card Generator (`src/`)

Data flow: Spotify API → CSV → PDF

- `main.py` - CLI entry point with `import` and `generate` subcommands
- `__main__.py` - Module entry point (enables `python -m src`)
- `spotify_importer.py` - Fetches playlist tracks via Spotipy, handles pagination, automatic retry with exponential backoff on rate limits
- `csv_parser.py` - Validates CSV, defines `Song` dataclass, converts URLs to `spotify:track:` URIs, sanitizes against CSV injection
- `qr_generator.py` - Creates QR codes (supports inverted white-on-transparent for dark backgrounds)
- `pdf_generator.py` - Generates double-sided A4 PDF with:
  - Front: Black background with concentric broken circles and centered white QR code
  - Back: Starburst design with year/title/artist, decade-based color themes (1950s-2020s)
  - Cards are mirrored on back pages for double-sided printing alignment
  - Named constants for all layout values (font sizes, radii, spacing)
  - Width-aware text truncation using reportlab's `stringWidth()`

### Web Player (`player/src/`)

**Application Flow:**
```
Login Screen → Device Selection → Player (Scanner)
      ↑              │
      └── Log out ───┘
                     │
                     ├── "This Browser" → SDKPlayer (Web Playback SDK, Premium required)
                     └── External Device → ExternalDevicePlayer (Spotify Connect, Premium required)
```

**Core Files:**
- `main.js` - Application orchestration, screen flow, event handling via AbortController
- `auth.js` - Spotify OAuth 2.0 with PKCE flow, token storage in localStorage, automatic refresh token rotation
- `scanner.js` - `QRScanner` class using html5-qrcode + jsQR for both normal and inverted QR codes, with `destroy()` cleanup
- `ui.js` - DOM manipulation utilities, toast notifications (max 2 visible), focus management between screens

**Playback Engine Architecture (Strategy Pattern):**
- `playback-engine.js` - Abstract base class with shared `_apiRequest()`, `_fetchTrackInfo()`, `_extractYear()`, and `SPOTIFY_API_BASE` constant
- `sdk-player.js` - Spotify Web Playback SDK for full tracks in browser (Premium required), 15s connection timeout
- `external-device-player.js` - Spotify Connect for external device playback (Premium required)
- `player-factory.js` - Factory for creating engines: `PlayerFactory.create('sdk'|'external')`

**Key Design Decisions:**
1. **Dual Scanning:** html5-qrcode for normal QR codes, plus jsQR with `inversionAttempts: 'attemptBoth'` for inverted codes. Animated scan line indicates active scanning.
2. **Strategy Pattern:** Playback engines share a common base class with shared API client, track info fetching, and year extraction. No code duplication between engines.
3. **Token Lifecycle:** OAuth PKCE flow with refresh token rotation. `getStoredToken()` is async and auto-refreshes near expiry. Centralized 401 handling.
4. **Event Listener Management:** AbortController pattern for all event listeners (replaced fragile cloneNode approach).
5. **Race Condition Guard:** `isPlaybackInProgress` flag prevents overlapping playback from rapid QR scans.
6. **Game Integrity:** Track year is not populated in the DOM until the reveal button is pressed.
7. **Accessibility:** ARIA labels, focus management between screens, `prefers-reduced-motion`, keyboard-navigable device items.

## Environment Variables

See `.env.example` (project root) and `player/.env.example` for required variables.

- **Card Generator:** `SPOTIPY_CLIENT_ID`, `SPOTIPY_CLIENT_SECRET` (or pass via CLI args)
- **Web Player:** `VITE_SPOTIFY_CLIENT_ID` (falls back to hardcoded default for dev), `VITE_ALLOWED_HOST`

## CSV Format

```csv
title,artist,year,spotify_url,preview_url
Bohemian Rhapsody,Queen,1975,https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv,https://p.scdn.co/mp3-preview/...
```

**Note:** The `preview_url` column is optional for backward compatibility.

## Spotify Setup

Both components need Spotify Developer credentials from https://developer.spotify.com/dashboard

- **Card Generator:** Set `SPOTIPY_CLIENT_ID` and `SPOTIPY_CLIENT_SECRET` env vars (recommended) or pass via `--client-id`/`--client-secret` CLI args
- **Web Player:** Set `VITE_SPOTIFY_CLIENT_ID` env var, add redirect URI `http://localhost:5173/callback` (requires Premium for playback)

## Card Specifications

- Size: 2.5" x 2.5" (square cards)
- Layout: A4 pages with crop marks
- Print: Double-sided, flip on short edge
- Decade color themes defined in `DECADE_THEMES` dict in `pdf_generator.py`

## Testing

- **Python:** `pytest` — 66 tests covering CSV parsing, QR generation, PDF layout, Spotify importer retry logic
- **JavaScript:** `vitest` — 40 tests covering auth, scanner URI extraction, playback engine base class

## Deployment

- Docker image built via GitHub Actions on push to `main`
- Production nginx with security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- Non-root nginx container (`nginxinc/nginx-unprivileged:alpine`) on port 8080
- CSP meta tag restricts script/style/connect sources
- PWA manifest at `/manifest.json`

## Security

- Content Security Policy via meta tag
- XSS protection: all user-facing data escaped via `escapeHtml()`, scanner debug uses `textContent` not `innerHTML`
- `window.hitsterDebug` only available in dev mode (`import.meta.env.DEV`)
- OAuth tokens auto-refresh; refresh token stored in localStorage
- CSV injection sanitized (values starting with `=`, `+`, `-`, `@` are prefixed)
- nginx security headers in production

## TODOs

### Remaining

- [ ] **Add shuffle command to CLI** - Users currently shuffle CSV manually
- [ ] **Add JSDoc types** - Document params/returns for playback engine methods
- [ ] **Handle autoplay restrictions** - Show "tap to play" overlay when browsers block autoplay
- [ ] **Add service worker for PWA** - Offline asset caching for spotty network conditions
- [ ] **Digital game mode** - Random song selection without physical cards (PlaybackEngine architecture supports this)
- [ ] **Split pdf_generator.py** - Separate layout, rendering, and theme modules for maintainability
- [ ] **Add error tracking** - Sentry or similar for production error monitoring
- [ ] **PWA icons** - Create 192px and 512px icons referenced in manifest.json
