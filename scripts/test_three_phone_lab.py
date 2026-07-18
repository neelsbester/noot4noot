"""End-to-end smoke test for the Cloudflare multiplayer game on three phones."""

from __future__ import annotations

import argparse
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, ConsoleMessage, Page, Route, expect, sync_playwright


SPOTIFY_SDK_STUB = """
class MockSpotifyPlayer {
  constructor() { this.listeners = new Map(); }
  addListener(name, callback) { this.listeners.set(name, callback); }
  connect() {
    setTimeout(() => this.listeners.get('ready')?.({ device_id: 'test-browser-device' }), 0);
    return Promise.resolve(true);
  }
  activateElement() { return Promise.resolve(); }
  disconnect() {}
}
window.Spotify = { Player: MockSpotifyPlayer };
window.onSpotifyWebPlaybackSDKReady?.();
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--screenshot", type=Path, default=Path("/tmp/noot4noot-three-phone-smoke.png"))
    args = parser.parse_args()
    origin = f"{urlparse(args.url).scheme}://{urlparse(args.url).netloc}"
    console_errors: list[str] = []
    page_errors: list[str] = []
    spotify_requests: list[tuple[str, str]] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        admin = playwright.request.new_context(
            base_url=origin,
            extra_http_headers={
                "Origin": origin,
                "X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com",
            },
        )
        invite_response = admin.post(
            "/api/admin/invites",
            data={"label": "Automated three-phone test", "lifetime": "day", "maxRedemptions": 10},
        )
        assert invite_response.status == 201, invite_response.text()
        invite_url = invite_response.json()["url"]

        host_context = browser.new_context(viewport={"width": 390, "height": 844})
        team_a_context = browser.new_context(viewport={"width": 390, "height": 844})
        team_b_context = browser.new_context(viewport={"width": 390, "height": 844})
        host_context.add_init_script("""
          localStorage.setItem('noot4noot_spotify_token', 'test-token');
          localStorage.setItem('noot4noot_spotify_token_expiry', String(Date.now() + 3_600_000));
        """)
        install_spotify_mocks(host_context, spotify_requests)
        install_spotify_mocks(team_a_context, spotify_requests)
        install_spotify_mocks(team_b_context, spotify_requests)

        pages = [
            new_observed_page(host_context, console_errors, page_errors),
            new_observed_page(team_a_context, console_errors, page_errors),
            new_observed_page(team_b_context, console_errors, page_errors),
        ]
        host, team_a, team_b = pages

        host.goto(invite_url, wait_until="domcontentloaded")
        host.locator("#game-entry").wait_for(state="visible")
        host.locator("#create-tab").click()
        host.locator("#starting-tokens").fill("5")
        host.locator("#create-panel button[type=submit]").click()
        host.wait_for_url("**/host?room=**")
        host.locator("#lobby").wait_for(state="visible")
        room = host.locator("#room-code").inner_text().strip()
        assert len(room) == 4

        join_team(team_a, invite_url, room, "Needle Crew")
        join_team(team_b, invite_url, room, "Bassline Club")
        team_a.locator("#lobby").wait_for(state="visible")
        team_b.locator("#lobby").wait_for(state="visible")
        host.locator("#lobby-teams .team-row").first.wait_for(state="visible")

        team_a.locator("#ready").click()
        team_b.locator("#ready").click()
        host.locator("#start-game").wait_for(state="visible")
        host.locator("#start-game").wait_for(state="attached")
        expect(host.locator("#start-game")).to_be_enabled()
        host.locator("#start-game").click()

        host.locator("#game").wait_for(state="visible")
        team_a.locator("#game").wait_for(state="visible")
        team_b.locator("#game").wait_for(state="visible")
        host.locator("#spotify-device option", has_text="This browser").wait_for(state="attached")
        assert host.locator("#spotify-device").input_value() == "test-browser-device"
        expect(host.locator("#play-song")).to_be_enabled()
        host.locator("#play-song").click()
        expect(host.locator("#phase")).to_have_text("placement")
        host.locator("#pause-song").click()
        expect(host.locator("#play-song")).to_have_text("Play again")
        host.locator("#play-song").click()

        active_name = host.locator("#active-team").inner_text().strip()
        active = team_a if active_name == "Needle Crew" else team_b
        rival = team_b if active is team_a else team_a
        active.locator("#timeline .timeline-gap:not([disabled])").first.click()
        active.locator("#lock-placement").wait_for(state="visible")
        active.locator("#lock-placement").click()
        rival.locator("#pass").wait_for(state="visible")
        rival.locator("#pass").click()

        expect(host.locator("#phase")).to_have_text("revealed")
        host.locator("#song-meta").wait_for(state="visible")
        correct = host.locator("#timeline .timeline-gap.is-correct")
        correct.wait_for(state="visible")
        first_reveal = host.locator("#stage-title").inner_text().strip()

        controller = team_a_context.new_page()
        controller.on("console", lambda message: console_errors.append(f"{controller.url}: {message.text}") if message.type == "error" else None)
        controller.on("pageerror", lambda error: page_errors.append(f"{controller.url}: {error}"))
        controller.goto(f"{origin}/host?room={room}&mode=controller", wait_until="domcontentloaded")
        controller.locator("#controller-note").wait_for(state="visible")
        assert controller.locator("#spotify-box").is_hidden()
        controller.locator("#back-to-team").wait_for(state="visible")
        controller.close()

        host.locator("#next-round").click()
        expect(host.locator("#round-number")).to_have_text("2")
        expect(host.locator("#active-team")).to_have_text("Bassline Club")
        team_b.locator("#buy-card").wait_for(state="visible")
        team_b.locator("#buy-card").click()
        expect(team_b.locator("#token-count")).to_have_text("2")
        expect(host.locator("#play-song")).to_be_enabled()
        host.locator("#play-song").click()
        expect(host.locator("#phase")).to_have_text("placement")
        team_b.locator("#replace-song").wait_for(state="visible")
        team_b.once("dialog", lambda dialog: dialog.accept())
        team_b.locator("#replace-song").click()
        expect(host.locator("#phase")).to_have_text("turn start")
        expect(team_b.locator("#token-count")).to_have_text("1")
        expect(host.locator("#play-song")).to_be_enabled()
        host.locator("#play-song").click()
        expect(host.locator("#phase")).to_have_text("placement")
        team_b.locator("#timeline .timeline-gap:not([disabled])").first.click()
        team_b.locator("#lock-placement").click()
        team_a.locator("#contest").wait_for(state="visible")
        team_a.locator("#contest").click()
        challenge_gaps = team_a.locator("#timeline .timeline-gap:not([disabled])")
        challenge_gaps.last.click()
        team_a.locator("#lock-challenge").wait_for(state="visible")
        team_a.locator("#lock-challenge").click()
        expect(host.locator("#phase")).to_have_text("revealed")
        second_reveal = host.locator("#stage-title").inner_text().strip()

        host.screenshot(path=str(args.screenshot), full_page=True)
        team_a.screenshot(path=str(args.screenshot.with_name(f"{args.screenshot.stem}-team-a.png")), full_page=True)
        team_b.screenshot(path=str(args.screenshot.with_name(f"{args.screenshot.stem}-team-b.png")), full_page=True)

        assert any(method == "PUT" and "/me/player/play" in url for method, url in spotify_requests)
        assert any(method == "PUT" and "/me/player/pause" in url for method, url in spotify_requests)
        assert all(page.evaluate("() => [innerWidth, innerHeight]") == [390, 844] for page in pages)
        assert all(
            page.evaluate("() => document.documentElement.scrollWidth <= innerWidth")
            for page in pages
        )

        admin_context = browser.new_context(
            viewport={"width": 1100, "height": 900},
            extra_http_headers={"X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com"},
        )
        admin_page = new_observed_page(admin_context, console_errors, page_errors)
        admin_page.goto(f"{origin}/admin", wait_until="domcontentloaded")
        admin_page.locator("#invite-form").wait_for(state="visible")
        admin_page.locator("#invite-label").fill("Browser-created invite")
        admin_page.locator("#invite-lifetime").select_option("month")
        admin_page.locator("#invite-cap").fill("3")
        admin_page.locator("#invite-form button[type=submit]").click()
        admin_page.locator("#invite-output").wait_for(state="visible")
        expect(admin_page.locator("#invite-url")).to_contain_text("?invite=")
        admin_context.close()

        host.evaluate(
            """room => {
              sessionStorage.setItem('noot4noot_game_auth_room', room);
              sessionStorage.setItem('noot4noot_game_auth_state', 'oauth-state');
              sessionStorage.setItem('noot4noot_game_code_verifier', 'verifier');
            }""",
            room,
        )
        host.goto(f"{origin}/callback?error=access_denied", wait_until="domcontentloaded")
        host.wait_for_url(f"**/host?room={room}")
        host.locator("#game").wait_for(state="visible")
        browser.close()

    ignored = ("favicon.ico", "net::ERR_ABORTED")
    relevant_console = [error for error in console_errors if not any(item in error for item in ignored)]
    if relevant_console or page_errors:
        raise SystemExit("Browser errors detected:\n" + "\n".join([*relevant_console, *page_errors]))

    print(
        f"PASS room={room} phones=3x390x844 active_team={active_name!r} "
        f"spotify=manual_play+resume+replacement+callback_recovery controller=delegated "
        f"reveals={first_reveal!r}/{second_reveal!r} admin=invite_created"
    )
    print(f"Screenshot: {args.screenshot}")


def install_spotify_mocks(
    context: BrowserContext,
    requests: list[tuple[str, str]],
) -> None:
    context.route(
        "https://sdk.scdn.co/spotify-player.js",
        lambda route: route.fulfill(
            status=200,
            content_type="application/javascript",
            body=SPOTIFY_SDK_STUB,
        ),
    )

    def mock_api(route: Route) -> None:
        requests.append((route.request.method, route.request.url))
        if route.request.method == "GET":
            route.fulfill(status=200, content_type="application/json", body='{"devices":[]}')
        else:
            route.fulfill(status=204, body="")

    context.route("https://api.spotify.com/v1/**", mock_api)


def new_observed_page(
    context: BrowserContext,
    console_errors: list[str],
    page_errors: list[str],
) -> Page:
    page = context.new_page()

    def capture(message: ConsoleMessage) -> None:
        if message.type == "error":
            console_errors.append(f"{page.url}: {message.text}")

    page.on("console", capture)
    page.on("pageerror", lambda error: page_errors.append(f"{page.url}: {error}"))
    return page


def join_team(page: Page, invite_url: str, room: str, name: str) -> None:
    page.goto(invite_url, wait_until="domcontentloaded")
    page.locator("#game-entry").wait_for(state="visible")
    page.locator("#room-code").fill(room)
    page.locator("#team-name").fill(name)
    page.locator("#join-panel button[type=submit]").click()
    page.wait_for_url(f"**/team?room={room}")


if __name__ == "__main__":
    main()
