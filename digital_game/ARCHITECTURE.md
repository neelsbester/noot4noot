# Digital Game Architecture

## Production component map

```text
Browser
  ├─ Workers Static Assets
  ├─ JSON API
  ├─ WebSocket revision stream
  └─ Spotify OAuth PKCE + Connect/Web Playback (host browser only)
          │
Cloudflare Worker router
  ├─ invitation/session gate
  ├─ security headers and bounded request validation
  ├─ Directory Durable Object (single low-volume administration atom)
  └─ Room Durable Object per room (independent game coordination atom)
```

The Python service in `service.py` and local server in `server.py` remain a
reference checkpoint during the Cloudflare migration. The deployed authority
is the TypeScript Worker under `src/`.

## Durable Object boundaries

### Directory

The directory is deliberately limited to low-volume global metadata:

- hashed invite tokens, lifetime, redemption count, cap, and revocation;
- hashed anonymous access sessions and expiry;
- room code allocation and room summary/index records;
- owner-only listing, invite creation/revocation, and forced room closure.

It does not process gameplay or fan out live room messages. At the expected
private-use scale this keeps administration simple without putting a global
object on the gameplay request path after room resolution.

### Room

Each room has its own `RoomDurableObject`, addressed deterministically by an
opaque room identifier. It owns:

- settings, status, roster, readiness, and team order;
- hashed host/team bearer tokens;
- shuffled deck and discarded/used songs;
- timelines, token balances, active team, and turn purchase state;
- current round, placements, challenge decisions, timer, and result;
- revision number and connected WebSockets;
- 24-hour expiry alarm.

SQLite is the source of truth. Mutations are synchronous SQLite transactions
inside the object; in-memory values are caches only.

## Request model

The Worker:

1. validates origin, content type, body size, route parameters, and access
   session;
2. addresses the room object directly by its validated four-character code;
3. calls typed Durable Object RPC methods;
4. returns role-scoped JSON or upgrades the request to the room WebSocket.

Browser clients send an idempotency key with each mutation. The room stores a
bounded result cache so retries caused by mobile reconnects cannot spend tokens
or advance phases twice.

## Realtime model

WebSockets carry only revision notifications and safe event labels. After a
notification, clients fetch or receive a full role-scoped snapshot. This keeps
reconnect and secrecy behavior straightforward:

- hibernating sockets reduce idle cost;
- socket attachments identify only the authenticated role/session;
- the room broadcasts after persistence succeeds;
- 700ms polling remains a fallback when WebSockets are unavailable;
- stale clients submit the last observed revision and receive a conflict when
  an action is no longer valid.

## Game state machine

```text
lobby
  └─ all teams ready + host start
      └─ turn_start
          ├─ optional one-time random-card purchase
          └─ host marks playback started
              ├─ active team replaces song → turn_start/playback cycle
              └─ placement
                  └─ active placement locked
                      └─ challenge
                          ├─ all rivals pass → automatic reveal
                          ├─ first contest + locked answer → automatic reveal
                          ├─ timer alarm → reveal
                          └─ host force reveal → reveal
                              ├─ target reached → finished
                              └─ host next round → turn_start
```

Starting the next round is a distinct host action so the playback browser can
pause the previous track before advancing. Server state never assumes a
Spotify command succeeded; playback status is a room hint used to enforce the
buy/replace windows.

## Visibility and authority

- The full curated deck exists in Worker code but current hidden song metadata
  remains inside the room object.
- Before reveal, normal teams receive only a mystery marker.
- Only the original playback host receives the Spotify URI before reveal.
  Delegated team controllers receive the same mystery marker as teams.
- Active placement is private until locked.
- A contest placement is private to the challenger and host controllers until
  locked.
- Full metadata appears only after the reveal mutation commits.
- All permissions are calculated server-side and serialized as `can` flags for
  presentation only; clients cannot grant themselves capabilities.
- User-controlled names are rendered through DOM text APIs, not HTML strings.

## Phone game layout

At phone widths, the timeline is the primary game surface. It renders as a
full-width vertical sequence of placement gaps and song cards so every choice
uses the natural page scroll direction and remains easy to tap. Round, team,
card, token, phase, current-turn context, and a compact role-switch shortcut
stay above it. A delegated host sees `Team` in the same position where the team
view shows `Host`. Team rosters are not repeated below the in-game timeline.
The host follows the same hierarchy, retaining only playback controls required
for the current song before the active timeline. Wider host and tablet screens
may use the horizontal timeline treatment.

## Three-phone test lab

The owner-only staging/local lab embeds one host and two team pages in a single
desktop window. It uses three fixed seat identifiers and three separate
HttpOnly room cookies, so iframe sessions cannot overwrite one another. Seat
cookies and the lab provisioning endpoint are rejected in production.

Only host/team pages carrying a valid lab seat may be framed by the same
origin; normal game pages retain `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. The lab shell itself may frame only same-origin
content. Its silent playback adapter is enabled only for a lab host in local
or staging, while the full-host link preserves the host seat for real Spotify
testing.

## Persistence and expiry

- Room mutations update state and `last_activity_at` atomically.
- A room alarm is always scheduled at the earliest of challenge deadline and
  24-hour inactivity expiry.
- Challenge alarms resolve idempotently and then reschedule room expiry.
- Expired rooms become terminal before retry-safe cleanup deletes their room
  data and prunes the directory summary.
- Results are retained for at most 24 hours.

## Environments

`wrangler.jsonc` defines isolated staging and production Worker names and
Durable Object namespaces.

- Staging route: `staging.noot4noot.bestermedia.me`
- Production route: `noot4noot.bestermedia.me`
- Staging is fully protected by Cloudflare Access.
- One exact Access service identity may administer staging solely for the
  authenticated post-deploy API smoke; its JWT claim shape and client ID are
  verified by the Worker, and the same identity is rejected in production.
- The full protected three-phone browser smoke runs from the development VM.
  Cloudflare Bot Fight Mode intentionally challenges GitHub-hosted browsers
  before Access, while authenticated POST checks remain suitable for CI.
- Production `/admin*` is protected by Cloudflare Access.
- Environment-specific Spotify client IDs are non-secret variables.
- Deployment credentials exist only as GitHub Actions secrets.

## Verification

- Pure rule tests cover every action and phase transition.
- Workers-runtime integration tests exercise bindings, SQLite persistence,
  alarms, authorization, idempotency, and serialization secrecy.
- Playwright drives host plus two isolated phone contexts through lobby,
  purchase/play/replace, placement, contest/pass, reveal, next round, delegated
  controls, and owner invite creation.
- A separate Playwright check drives the visible one-window test lab through
  provisioning, quick start, simulated playback, placement, pass, reveal, and
  hard assertions that all three phone timelines use the vertical layout.
- Responsive screenshots and hard width assertions cover 390×844 phones.
