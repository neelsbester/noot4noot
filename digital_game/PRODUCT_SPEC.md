# Noot4Noot Multiplayer Product Specification

Status: implementation baseline  
Last updated: 2026-07-18

## Product

Noot4Noot is a private, invite-only multiplayer music timeline game for a host
and 2–8 teams. The host creates a room and controls Spotify playback from one
browser. Each team joins from one phone or tablet, listens to the same song,
and places the mystery card on a shared chronological timeline.

The application is permanently available at:

- Production: `https://noot4noot.bestermedia.me`
- Staging: `https://staging.noot4noot.bestermedia.me`

Staging is protected by Cloudflare Access for
`neelsbester1993@gmail.com`. Production game entry is gated by invite links;
production `/admin` is protected by Cloudflare Access for the same address.

## Access and sessions

- The owner creates group invite links from `/admin`.
- Invite lifetime options are 24 hours, one month, or indefinite.
- An invite defaults to 20 browser redemptions and may be revoked.
- A valid redemption creates an anonymous browser session that can create and
  join rooms. There are no user accounts in the first release.
- Invite expiry or revocation prevents new redemptions but never interrupts an
  active game.
- One team session is supported per device/browser seat.
- Room and invite sessions are opaque, unguessable bearer tokens.
- Rooms and results expire no later than 24 hours after their last activity.

## Room setup

The room creator configures:

- Deck: curated decks only; first release is **Millennial Anthems** (200 songs).
- Target cards: default 10.
- Starting tokens: default 2.
- Challenge timer: off, 30, 45, or 60 seconds.
- Title-and-artist bonus: enabled by default.

Fixed first-release rules:

- 2–8 teams.
- Every team must mark itself ready before the game starts.
- The roster locks when the game starts.
- Teams may be removed by a host controller; play continues with remaining
  teams if at least two remain.
- A rematch preserves the roster and settings but uses a fresh shuffled game.
- All team devices can switch into host controls without a separate host code.
- Several devices may show host controls simultaneously.
- Spotify playback remains on the original playback browser. Other host
  controllers change game state only.

## Round flow

1. At the start of its turn, before playback, the active team may buy one
   random timeline card for 3 tokens.
2. The playback host manually starts the mystery song from its beginning.
3. After playback begins, the active team may replace the song immediately for
   1 token. It may replace multiple songs in the same round while it has
   tokens. Replaced songs are discarded for the game. Each replacement must be
   started manually by the playback host.
4. The active team places and locks the mystery card on its timeline.
5. Rival teams choose **Contest** or **No contest**.
6. The first rival to contest spends 1 token, claims the challenge, chooses a
   different position, and locks out all other rivals.
7. If every rival chooses no contest, the card reveals automatically.
8. If a rival contests and locks, the card reveals automatically.
9. With the timer enabled, the challenge window resolves when it expires.
   Without a timer, or when a device does not respond, any host controller may
   force reveal.
10. Reveal does not pause the song. Starting the next round pauses the previous
    song and advances the active team.

Placement and reveal are server authoritative. The active team wins a correctly
placed card. A correct contest wins the card for the challenger. If neither is
correct, the card is discarded. Equal release years may occupy any
chronologically valid gap.

## Tokens and winning

- Token balances are clamped to 0–5.
- Contesting costs 1 token.
- Replacing a song costs 1 token.
- A random timeline card costs 3 tokens and is limited to one purchase at the
  start of a team's turn.
- The host manually awards the optional 1-token title-and-artist bonus.
- The first team to reach the configured card target wins.

## Spotify

- Each room creator uses their own Spotify Premium account.
- Spotify Authorization Code with PKCE runs only in the playback browser.
- Spotify access and refresh tokens remain in that browser's storage and are
  never sent to the Noot4Noot server.
- Sessions follow Spotify's normal refresh lifecycle. An explicit disconnect
  control clears local Spotify credentials.
- Supported playback targets are the Spotify Web Playback SDK in the host
  browser and available Spotify Connect devices.
- Current iOS Safari, Android Chrome, desktop Chrome/Edge/Safari are supported;
  Firefox is best effort.

## Experience

- Phone portrait is the primary team and host-controller layout.
- Tablet and desktop layouts expand the same information hierarchy.
- Visual direction is calm and editorial: warm light surfaces, restrained
  decade colours, ink-like typography, and limited animation.
- The game is English-only for the first release.
- Basic WCAG 2.2 AA expectations apply: semantic controls, keyboard access,
  visible focus, sufficient contrast, reduced-motion support, and useful live
  announcements.

## Operations and privacy

- Cloudflare Workers Static Assets serves the application.
- A SQLite-backed Durable Object is the single authority for each room.
- A small directory Durable Object owns invites, anonymous access sessions,
  room summaries, and owner administration.
- Hibernating WebSockets push revisions; reconnecting clients can always fetch
  a full authoritative snapshot.
- Cloudflare alarms expire rooms and timed challenge windows.
- No user analytics or third-party tracking is collected.
- Only short-lived Cloudflare request and error logs are used for diagnosis.
- Expected capacity is 2–3 simultaneous rooms and a maximum operating budget
  of USD 10/month; the design targets the Cloudflare free tier.

## Delivery

- Pull requests run tests and build validation without deploying.
- A merge to `main` automatically deploys the staging environment.
- Production is a separate manually triggered GitHub Actions workflow.
- The production workflow is triggered only after explicit user approval.
- Existing games may finish during a release. New room creation may be
  prevented during an incompatible maintenance window.

