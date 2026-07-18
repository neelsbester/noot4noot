# Digital Game Architecture

## Component map

```text
digital_game/
  server.py                  Dependency-free threaded HTTP/JSON server
  service.py                 Authoritative rooms, teams, rounds, rules, and serialization
  web/
    index.html               Join/create-room entry screen
    landing.js               Room creation and team joining
    host.html / host.js      Host table, Spotify, reveal, tokens, round control
    team.html / team.js      Team placement, challenge, pass, reveal, drag interaction
    shared.js                API helpers, session storage, timeline rendering and animation
    spotify.js               Spotify PKCE, token refresh, Connect API requests
    spotify-browser-player.js Web Playback SDK adapter for audio in the host browser
    test-lab.html / .js      Local host-plus-two-team QA harness with isolated seats
    game.css                 Shared mobile-first portrait and responsive tablet/host UI
tests/
  test_digital_game.py       Rule, visibility, HTTP, challenge, pass, and reveal coverage
mockups/digital-game/        Earlier interactive design reference
```

The server intentionally uses only the Python standard library. The browser implementation is dependency-free JavaScript apart from Spotify's hosted Web Playback SDK.

## Runtime model

`GameService` owns all mutable game state. `GameHTTPServer` exposes it through a small JSON API and serves the static web application.

State mutations run under a re-entrant lock. Every successful action increments the room `revision`. Host and team pages poll state roughly every 700ms and rerender only when the revision changes.

Every mutation is atomically written to `digital_game/.data/rooms.json` by the CLI server and restored at startup. The path is configurable with `--state-file`; direct `GameService` and `build_server` use remains isolated unless a path is supplied. Browser role tokens survive refresh and remain valid after server recovery. Restarting a separately launched Cloudflare tunnel is what changes the temporary public hostname.

The optional `seat` query parameter namespaces browser session keys. The local test lab uses it to run one host and two independent team identities in same-origin iframes without overwriting each other's tokens.

## Domain model

### Room

- Four-character code.
- Opaque host token.
- Ordered team collection.
- Shuffled deck and used-song set.
- Active-team index, status, target score, token configuration, and revision.
- Four-digit host control code, authorized cohost team IDs, and terminal winner/reason.
- Current round.

### Team

- Opaque ID and session token.
- Display name.
- Token balance.
- Sorted timeline of song IDs.

### Round

- Round number, hidden song ID, and active team.
- Active placement and optional challenger placement.
- Set of teams that passed the challenge window.
- Pre-reveal timeline snapshot and canonical correct placement.
- Outcome and winning team after reveal.

## Round state machine

```text
lobby
  -> placement
  -> challenge
       -> reveal_ready                 all rivals pass or host closes
       -> challenge placement
            -> reveal_ready            challenger locks
  -> revealed                          host or active team reveals
  -> placement                         host starts next round
  -> finished                          target reached or deck exhausted
```

Only the active team can place and lock the initial card. A rival can either claim the challenge or pass. Passing is irreversible for that round. A claimed challenge immediately locks out all other rivals.

The host can close an unclaimed challenge window manually. This remains useful when a team device disconnects before passing.

## Placement and reveal calculation

Timeline placement is server-authoritative. A slot is valid when the mystery year lies between the years on its left and right. Equal-year boundaries are accepted.

At reveal time the service:

1. Copies the active timeline into `reveal_timeline_song_ids`.
2. Evaluates the active placement and optional challenge placement.
3. Stores the winning placement when either answer is correct.
4. Otherwise calculates a canonical correct slot using `(year, casefolded title)`, matching permanent timeline sorting.
5. Awards the card according to the outcome.
6. Serializes the pre-reveal snapshot plus `correct_placement` for the explanation animation.

The client uses those fields to pulse a correct card in place or animate an incorrect card from the locked slot to the correct slot. The actual updated timeline appears when the next round starts.

## Challenge and token rules

- Claiming a challenge costs one token immediately.
- A team that passed cannot later challenge that round.
- Every non-active team must pass before an unclaimed window closes automatically.
- A successful challenger receives the card; the card is not removed from the active team because it had not yet been awarded.
- Host token adjustments are limited to `+1` and `-1`, clamped to `0..5`.
- Buying a random card costs three tokens and inserts a newly drawn song in sorted order.
- Reaching the target through either a reveal or a random-card purchase records the room winner and gates every subsequent action.

## API surface

### Public and session endpoints

```text
GET  /api/health
GET  /api/config
POST /api/rooms
POST /api/rooms/{code}/teams
GET  /api/rooms/{code}/state
POST /api/rooms/{code}/actions
```

Authenticated requests use `Authorization: Bearer <session-token>`.

### Actions

```text
start_game
place
lock_placement
claim_challenge
pass_challenge
place_challenge
lock_challenge
close_challenge
skip_song
reveal
next_round
adjust_tokens
buy_random_card
authorize_cohost
```

Each handler validates the caller role, round phase, and rule-specific preconditions before mutating state.

## Information visibility

- Before reveal, team clients receive only `{ "id": "mystery" }` for the current song.
- The host receives the Spotify URI and URL so it can start playback, but not the title, artist, or year.
- Active placement is hidden from other teams during the placement phase.
- Challenge placement is hidden from non-host, non-challenger clients until answers are locked.
- Full song metadata is serialized only after reveal.

Team sessions cannot request cohost mode until `authorize_cohost` succeeds with the room's four-digit control code. The original host sees that code; normal team state does not expose it. Authorization is persisted for that team session.

This is game secrecy and a practical trusted-room boundary, not hardened internet identity. A future public deployment should add account identities, stronger session lifecycle controls, rate limiting, code-attempt throttling, and production headers.

## Spotify path

`spotify.js` implements Authorization Code with PKCE and refreshes tokens in browser storage. The authorization and token requests use the exact same callback URI.

For local HTTP, the callback is normalized to `http://127.0.0.1:<port>/callback`. HTTPS hosts use their current origin.

The host can target an external Spotify Connect device or initialize `spotify-browser-player.js`, which registers the browser as a Connect device. Before playing in the browser, the Play button calls `activateElement()` to satisfy mobile Safari's user-gesture requirement. Playback is transferred to the selected device before the mystery track is started.

## Continuing development

Recommended first checks in a new session:

1. Read `digital_game/README.md` and this file.
2. Run `git status --short` because the wider repository may contain unrelated work.
3. Run the focused digital tests.
4. Start the Python server and Cloudflare tunnel as separate processes when backend reloads are expected.
5. Register the tunnel's exact `/callback` URI before testing Spotify on iPad.
6. Use disposable rooms for rule and animation work, and delete `digital_game/.data/rooms.json` when a clean local slate is required.

For fast UI regression checks, open `/test-lab`, create a three-phone room, and use **Quick start**. The lab is only linked from loopback origins and is development tooling, not a production administration surface.

Keep rule changes in `service.py` first, expose only the minimum new serialized state, then implement the corresponding host/team presentation. Add a service-level test for every new action or phase transition.
