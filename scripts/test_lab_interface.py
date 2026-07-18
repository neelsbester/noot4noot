"""Exercise the one-window Noot4Noot host plus two-team test interface."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Page, expect, sync_playwright
from test_three_phone_lab import (
    CHROME_USER_AGENT,
    STAGING_ORIGIN,
    authenticate_access,
    close_context,
    filter_console_errors,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--screenshot", type=Path, default=Path("/tmp/noot4noot-test-lab.png"))
    parser.add_argument("--access-client-id", default=os.environ.get("NOOT4NOOT_ACCESS_CLIENT_ID", ""))
    parser.add_argument("--access-client-secret", default=os.environ.get("NOOT4NOOT_ACCESS_CLIENT_SECRET", ""))
    args = parser.parse_args()
    if bool(args.access_client_id) != bool(args.access_client_secret):
        parser.error("both Access service-token values are required")
    if args.access_client_id and args.url.rstrip("/") != STAGING_ORIGIN:
        parser.error(f"Access service-token values may only be sent to {STAGING_ORIGIN}")
    origin = f"{urlparse(args.url).scheme}://{urlparse(args.url).netloc}"
    access_headers = {
        "CF-Access-Client-Id": args.access_client_id,
        "CF-Access-Client-Secret": args.access_client_secret,
    } if args.access_client_id else {}
    console_errors: list[str] = []
    page_errors: list[str] = []
    room = ""

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 1100},
            user_agent=CHROME_USER_AGENT,
        )
        authenticate_access(context, origin, access_headers)
        page = context.new_page()
        observe(page, console_errors, page_errors)
        try:
            page.goto(f"{origin}/test-lab", wait_until="domcontentloaded")
            page.locator("#new-room").click()
            page.locator("#lab-room").wait_for(state="visible")
            expect(page.locator("#lab-room")).not_to_have_text("—")
            room = page.locator("#lab-room").inner_text().strip()
            assert len(room) == 4

            host = page.frame_locator("#host-frame")
            team_a = page.frame_locator("#team-a-frame")
            team_b = page.frame_locator("#team-b-frame")
            host.locator("#lobby").wait_for(state="visible")
            team_a.locator("#lobby").wait_for(state="visible")
            team_b.locator("#lobby").wait_for(state="visible")
            expect(team_a.locator("#lobby-title")).to_contain_text("Needle Crew")
            expect(team_b.locator("#lobby-title")).to_contain_text("Bassline Club")

            page.locator("#quick-start").click()
            host.locator("#game").wait_for(state="visible")
            team_a.locator("#game").wait_for(state="visible")
            team_b.locator("#game").wait_for(state="visible")
            expect(host.locator("#spotify-connect")).to_have_text("Simulation ready")
            expect(host.locator("#spotify-device")).to_have_value("test-lab-silent-player")
            expect(host.locator("#spotify-refresh")).to_be_hidden()
            expect(host.locator("#pause-song")).to_be_hidden()
            expect(host.locator("#spotify-fallback")).to_be_hidden()

            team_a.locator("#host-controls").click()
            team_a.locator("#controller-note").wait_for(state="visible")
            expect(team_a.locator("#back-to-team")).to_be_visible()
            controller_url = page.locator("#team-a-frame").evaluate(
                "(frame) => frame.contentWindow.location.href",
            )
            assert "seat=lab-team-a" in controller_url
            assert "mode=controller" in controller_url
            team_a.locator("#back-to-team").click()
            team_a.locator("#game").wait_for(state="visible")
            expect(team_a.locator("#team-name")).to_have_text("Needle Crew")

            expect(host.locator("#play-song")).to_be_enabled()
            host.locator("#play-song").click()
            expect(host.locator("#phase")).to_have_text("placement")

            active_name = host.locator("#active-team").inner_text().strip()
            active = team_a if active_name == "Needle Crew" else team_b
            rival = team_b if active is team_a else team_a
            active.locator("#timeline .timeline-gap:not([disabled])").first.click()
            active.locator("#lock-placement").wait_for(state="visible")
            active.locator("#lock-placement").click()
            rival.locator("#pass").wait_for(state="visible")
            rival.locator("#pass").click()
            expect(host.locator("#phase")).to_have_text("revealed")
            expect(page.locator("#lab-phase")).to_have_text("revealed")
            expect(page.locator("#lab-status")).to_contain_text("Use Next round")
            full_host_url = page.locator("#full-host").get_attribute("href") or ""
            assert "seat=lab-host" in full_host_url
            assert "lab=1" not in full_host_url

            page.locator("#reload-frames").click()
            expect(host.locator("#phase")).to_have_text("revealed")
            expect(team_a.locator("#team-name")).to_have_text("Needle Crew")
            expect(team_b.locator("#team-name")).to_have_text("Bassline Club")

            page.locator(".focus-device").first.click()
            expect(page.locator(".device.is-focused")).to_have_count(1)
            expect(page.locator(".device:not(.is-focused)").first).to_be_hidden()
            page.locator(".focus-device").first.click()
            expect(page.locator(".device")).to_have_count(3)
            expect(page.locator(".device").last).to_be_visible()

            page.reload(wait_until="domcontentloaded")
            expect(page.locator("#lab-room")).to_have_text(room)
            host = page.frame_locator("#host-frame")
            host.locator("#game").wait_for(state="visible")
            expect(host.locator("#phase")).to_have_text("revealed")

            with page.expect_popup() as opened_host:
                page.locator("#full-host").click()
            full_host = opened_host.value
            observe(full_host, console_errors, page_errors)
            full_host.locator("#game").wait_for(state="visible")
            expect(full_host.locator("#spotify-connect")).to_have_text("Connect Spotify")
            assert "seat=lab-host" in full_host.url
            assert "lab=1" not in full_host.url
            full_host.close()

            page.screenshot(path=str(args.screenshot), full_page=True)
            assert page.evaluate("() => document.documentElement.scrollWidth <= innerWidth")
        finally:
            if room:
                context.request.post(
                    f"{origin}/api/admin/rooms/{room}/close",
                    data={},
                    headers={
                        "Origin": origin,
                        "X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com",
                        **access_headers,
                    },
                )
            close_context(context)
            browser.close()

    relevant_console = filter_console_errors(
        console_errors,
        origin if access_headers else "",
        [],
    )
    if relevant_console or page_errors:
        raise SystemExit("Browser errors detected:\n" + "\n".join([*relevant_console, *page_errors]))
    print(
        f"PASS room={room} one_window=host+2_teams isolated_seats=true "
        f"simulation=play+placement+reveal controller=team_to_host_to_team "
        f"restore=frames+shell full_host=opens focus=working screenshot={args.screenshot}"
    )


def observe(page: Page, console_errors: list[str], page_errors: list[str]) -> None:
    page.on(
        "console",
        lambda message: console_errors.append(f"{page.url}: {message.text}")
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: page_errors.append(f"{page.url}: {error}"))


if __name__ == "__main__":
    main()
