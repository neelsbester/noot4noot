# Noot4Noot Player

Browser-based QR scanner and Spotify player for Noot4Noot cards.

## Requirements

- Spotify Premium for playback control.
- A Spotify Developer app with `http://127.0.0.1:5173/callback` registered as a redirect URI.
- A modern browser with camera access.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set `VITE_SPOTIFY_CLIENT_ID` in `.env`, then open `http://127.0.0.1:5173`.

When testing from a phone, use the computer's LAN IP instead of `localhost`, for example `http://192.168.0.6:5173`. That can load the app shell, but Spotify PKCE login and camera access may require HTTPS on mobile browsers. For full phone testing, use an HTTPS tunnel or local HTTPS certificate and register that exact `/callback` URL in the Spotify Developer Dashboard.

For a tunnel such as `https://noot4noot.bestermedia.me`, set:

```env
VITE_ALLOWED_HOSTS=192.168.0.6,noot4noot.bestermedia.me
```

Then add this redirect URI in Spotify:

```text
https://noot4noot.bestermedia.me/callback
```

## Scripts

```bash
npm run dev      # local dev server
npm test         # vitest
npm run build    # production build
```

## Usage

1. Connect with Spotify.
2. Select "This Browser" or an external Spotify Connect device.
3. Hold a Noot4Noot QR card up to the camera.
4. Let players guess the year.
5. Tap "Reveal Song Info" to show the answer.

## Deployment

The Dockerfile builds the Vite app and serves it with unprivileged nginx on port `8080`. Set `VITE_SPOTIFY_CLIENT_ID` as a build argument or CI secret, and add the production callback URL to the Spotify app dashboard.
