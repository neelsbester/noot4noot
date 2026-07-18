"""Headless end-to-end smoke test for the three-phone digital game lab."""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import ConsoleMessage, Page, Route, sync_playwright


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
    parser.add_argument("--url", default="http://127.0.0.1:5173/test-lab")
    parser.add_argument("--screenshot", type=Path, default=Path("/tmp/noot4noot-three-phone-smoke.png"))
    args = parser.parse_args()

    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page: Page = browser.new_page(viewport={"width": 1920, "height": 1080})

        page.add_init_script("""
          localStorage.setItem('noot4noot_spotify_token', 'test-token');
          localStorage.setItem('noot4noot_spotify_token_expiry', String(Date.now() + 3_600_000));
        """)
        page.route(
            "https://sdk.scdn.co/spotify-player.js",
            lambda route: route.fulfill(status=200, content_type="application/javascript", body=SPOTIFY_SDK_STUB),
        )

        spotify_requests: list[tuple[str, str]] = []

        def mock_spotify_api(route: Route) -> None:
            spotify_requests.append((route.request.method, route.request.url))
            if route.request.method == "GET":
                route.fulfill(status=200, content_type="application/json", body='{"devices": []}')
            else:
                route.fulfill(status=204, body="")

        page.route("https://api.spotify.com/v1/**", mock_spotify_api)

        def capture_console(message: ConsoleMessage) -> None:
            if message.type == "error":
                console_errors.append(message.text)

        page.on("console", capture_console)
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle")
        page.locator("#new-lab-game").click()
        page.locator("#lab-room").wait_for(state="visible")
        page.wait_for_function("document.querySelector('#lab-room').textContent !== '----'")
        room = page.locator("#lab-room").inner_text()

        host = page.frame_locator("#host-frame")
        team_a = page.frame_locator("#team-a-frame")
        team_b = page.frame_locator("#team-b-frame")
        host.locator("#host-lobby").wait_for(state="visible")
        team_a.locator("#team-lobby").wait_for(state="visible")
        team_b.locator("#team-lobby").wait_for(state="visible")
        host_handoff_url = page.locator("#open-host-tab").evaluate("element => element.href")
        assert host_handoff_url and "#host_session=" in host_handoff_url

        phone_context = browser.new_context(viewport={"width": 390, "height": 844})
        phone_host = phone_context.new_page()
        phone_host.goto(host_handoff_url, wait_until="domcontentloaded")
        phone_host.locator("#host-lobby").wait_for(state="visible")
        assert f"/host?room={room}&seat=lab-host&lab=1" in phone_host.url
        assert "#host_session=" not in phone_host.url
        phone_context.close()

        rigs = page.locator(".device-rig").all()
        rig_boxes = [rig.bounding_box() for rig in rigs]
        assert all(box is not None for box in rig_boxes)
        assert max(box["y"] for box in rig_boxes if box) - min(box["y"] for box in rig_boxes if box) < 2
        assert [box["x"] for box in rig_boxes if box] == sorted(box["x"] for box in rig_boxes if box)
        assert host.locator("body").evaluate("() => [window.innerWidth, window.innerHeight]") == [390, 844]
        assert team_a.locator("body").evaluate("() => [window.innerWidth, window.innerHeight]") == [390, 844]
        assert team_b.locator("body").evaluate("() => [window.innerWidth, window.innerHeight]") == [390, 844]

        page.locator("#quick-start").click()
        host.locator("#host-game").wait_for(state="visible")
        host.locator("#host-phase").wait_for(state="visible")
        host.locator("#spotify-device-select option", has_text="This browser").wait_for(state="attached")
        assert host.locator("#spotify-device-select").input_value() == "test-browser-device"
        assert host.locator("#play-song-button").is_enabled()
        requests_before_play = len(spotify_requests)
        host.locator("#play-song-button").click()
        host.locator("#toast", has_text="Mystery song is playing").wait_for(state="visible")
        play_commands = spotify_requests[requests_before_play:]
        assert len(play_commands) == 1
        assert play_commands[0][0] == "PUT"
        assert "/me/player/play?device_id=test-browser-device" in play_commands[0][1]
        active_name = host.locator("#host-active-team").inner_text().strip()
        active = team_a if active_name == "Needle Crew" else team_b
        rival = team_b if active_name == "Needle Crew" else team_a

        first_song_url = host.locator("#spotify-fallback-link").get_attribute("href")
        host.locator("#skip-song-button").click()
        page.wait_for_function(
            """before => document.querySelector('#host-frame').contentDocument
              .querySelector('#spotify-fallback-link').getAttribute('href') !== before""",
            arg=first_song_url,
        )
        assert host.locator("#host-round-number").inner_text() == "01"
        assert host.locator("#host-active-team").inner_text().strip() == active_name

        active.locator("#team-timeline .timeline-gap:not([disabled])").first.click()
        active.locator("#team-main-button", has_text="Lock in position").click()
        rival.locator("#no-challenge-button").wait_for(state="visible")
        rival.locator("#no-challenge-button").click()

        active.locator("#team-main-button", has_text="Flip & reveal").wait_for(state="visible")
        active.locator("#team-main-button", has_text="Flip & reveal").click()
        page.wait_for_function(
            "document.querySelector('#host-frame').contentDocument.querySelector('#host-phase').textContent === 'REVEALED'"
        )

        reveal_card = host.locator("[data-reveal-card]")
        reveal_card.wait_for(state="visible")
        if reveal_card.get_attribute("data-was-correct") == "true":
            host.locator("[data-reveal-card].is-confirmed").wait_for(state="visible")
            reveal_result = "correct placement highlighted"
        else:
            host.locator("[data-reveal-card].is-settled").wait_for(state="visible")
            reveal_result = "incorrect placement moved to the correct gap"

        page.screenshot(path=str(args.screenshot), full_page=True)
        browser.close()

    ignored_console_fragments = ("favicon.ico", "net::ERR_ABORTED")
    relevant_console_errors = [
        error for error in console_errors if not any(fragment in error for fragment in ignored_console_fragments)
    ]
    if relevant_console_errors or page_errors:
        details = "\n".join([*relevant_console_errors, *page_errors])
        raise SystemExit(f"Browser errors detected:\n{details}")

    print(f"PASS room={room} phones=3x390x844_portrait_row spotify=single_play_command active_team={active_name!r} skip=redrew_same_round reveal={reveal_result}")
    print(f"Screenshot: {args.screenshot}")


if __name__ == "__main__":
    main()
