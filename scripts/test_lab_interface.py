"""Exercise the one-window Noot4Noot host plus two-team test interface."""

from __future__ import annotations

import argparse
import csv
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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
    deck_path = Path(__file__).parents[1] / "digital_game" / "decks" / "millennial-anthems.csv"
    with deck_path.open(newline="", encoding="utf-8") as deck_file:
        deck_years = {
            row["spotify_url"].rsplit("/", 1)[-1]: int(row["year"])
            for row in csv.DictReader(deck_file)
        }

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
            page.goto(f"{origin}/test-phone.html?view=team-a", wait_until="domcontentloaded")
            page.wait_for_url(re.compile(r"/team\?.*seat=lab-team-a"))
            page.locator("#lobby").wait_for(state="visible")
            expect(page.locator("#lobby-title")).to_contain_text("Needle Crew")
            direct_room = parse_qs(urlparse(page.url).query)["room"][0]
            context.request.post(
                f"{origin}/api/admin/rooms/{direct_room}/close",
                data={},
                headers={
                    "Origin": origin,
                    "X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com",
                    **access_headers,
                },
            )

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
            expect(page.locator("#open-host")).to_have_attribute("href", re.compile(r"seat=lab-host.*lab=1"))
            expect(page.locator("#open-team-a")).to_have_attribute("href", re.compile(r"seat=lab-team-a"))
            expect(page.locator("#open-team-b")).to_have_attribute("href", re.compile(r"seat=lab-team-b"))
            with page.expect_popup() as opened_team:
                page.locator("#open-team-a").click()
            full_team = opened_team.value
            observe(full_team, console_errors, page_errors)
            full_team.locator("#lobby").wait_for(state="visible")
            expect(full_team.locator("#lobby-title")).to_contain_text("Needle Crew")
            full_team.close()

            team_a.locator("#ready").click()
            expect(team_a.locator("#ready")).to_have_text("Not ready yet")
            team_b.locator("#ready").click()
            expect(team_b.locator("#ready")).to_have_text("Not ready yet")
            expect(host.locator("#start-game")).to_be_enabled()
            host.locator("#start-game").click()
            host.locator("#game").wait_for(state="visible")
            team_a.locator("#game").wait_for(state="visible")
            team_b.locator("#game").wait_for(state="visible")
            expect(host.locator("#spotify-connect")).to_be_hidden()
            expect(host.locator("#spotify-device")).to_have_value("test-lab-silent-player")
            expect(host.locator("#spotify-refresh")).to_be_hidden()
            expect(host.locator("#pause-song")).to_be_hidden()
            expect(host.locator("#spotify-fallback")).to_be_hidden()
            for phone in (host, team_a, team_b):
                timeline = phone.locator("#timeline")
                assert timeline.evaluate("(element) => getComputedStyle(element).flexDirection") == "column"
                card = timeline.locator(".timeline-card").first
                assert card.evaluate(
                    "(element) => element.getBoundingClientRect().width "
                    "/ element.parentElement.getBoundingClientRect().width > 0.95",
                )
            for team in (team_a, team_b):
                expect(team.locator("#host-controls")).to_be_visible()
                expect(team.locator("#game-teams")).to_have_count(0)
                assert team.locator("#host-controls").evaluate(
                    "(button) => button.getBoundingClientRect().top "
                    "< document.querySelector('#timeline').getBoundingClientRect().top",
                )

            team_host_box = team_a.locator("#host-controls").evaluate(
                "(button) => ({ left: button.getBoundingClientRect().left, "
                "right: button.getBoundingClientRect().right })",
            )
            team_a.locator("#host-controls").click()
            team_a.locator("#controller-note").wait_for(state="visible")
            expect(team_a.locator("#back-to-team")).to_be_visible()
            expect(team_a.locator("#back-to-team")).to_have_text("Team")
            team_button_box = team_a.locator("#back-to-team").evaluate(
                "(button) => ({ left: button.getBoundingClientRect().left, "
                "right: button.getBoundingClientRect().right })",
            )
            assert abs(team_button_box["right"] - team_host_box["right"]) <= 1, (
                team_host_box,
                team_button_box,
            )
            assert team_a.locator("#back-to-team").evaluate(
                "(button) => button.getBoundingClientRect().top "
                "< document.querySelector('#timeline').getBoundingClientRect().top",
            )
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
            state_response = context.request.get(
                f"{origin}/api/rooms/{room}/state?seat=lab-host",
                headers=access_headers,
            )
            assert state_response.ok
            host_state = state_response.json()
            track_id = host_state["round"]["song"]["spotifyUri"].rsplit(":", 1)[-1]
            mystery_year = deck_years[track_id]
            correct_slot = sum(song["year"] <= mystery_year for song in host_state["activeTimeline"])
            active.locator(
                f"#timeline .timeline-gap:not([disabled])[data-slot='{correct_slot}']",
            ).click()
            active.locator("#lock-placement").wait_for(state="visible")
            expect(active.locator("#timeline")).to_have_class(
                re.compile(r"\bis-placement-focused\b"),
            )
            active_timeline = active.locator("#timeline")
            action_bar = active.locator(".timeline-panel > .action-row")
            assert action_bar.evaluate("(element) => getComputedStyle(element).position") == "sticky"
            assert action_bar.evaluate(
                "(element) => Boolean(element.compareDocumentPosition("
                "document.querySelector('#timeline')) & Node.DOCUMENT_POSITION_FOLLOWING)",
            )
            active_timeline.evaluate(
                """(timeline) => {
                  const cards = [...timeline.children].map((child) => child.cloneNode(true));
                  for (let copy = 0; copy < 5; copy += 1) {
                    for (const card of cards) timeline.append(card.cloneNode(true));
                  }
                  window.scrollTo(0, timeline.getBoundingClientRect().top + window.scrollY + 300);
                }""",
            )
            assert action_bar.evaluate("(element) => element.getBoundingClientRect().top <= 8")
            active_timeline.evaluate("() => window.scrollTo(0, 0)")
            active.locator("#lock-placement").click()
            expect(active.locator("#lock-placement")).to_have_class(
                re.compile(r"\bis-locking\b"),
            )
            rival.locator("#pass").wait_for(state="visible")
            rival.locator("#pass").click()
            expect(host.locator("#phase")).to_have_text("revealed")
            for phone in (host, team_a, team_b):
                reveal_card = phone.locator("#round-reveal-card")
                expect(reveal_card).to_be_visible()
                expect(reveal_card).to_have_class(
                    re.compile(r"\bmotion-reveal-flip\b"),
                )
                expect(reveal_card).to_have_class(
                    re.compile(r"\bmotion-earned-card\b"),
                )
                expect(reveal_card.locator("[data-reveal-award]")).to_contain_text("Added to")
            expect(page.locator("#lab-phase")).to_have_text("revealed")
            expect(page.locator("#lab-status")).to_contain_text("Use Next round")
            host.locator("#award-bonus").click()
            expect(active.locator("#token-count")).to_have_class(
                re.compile(r"\bmotion-token-ring\b"),
            )
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

            previous_active = host.locator("#active-team").inner_text().strip()
            host.locator("#next-round").click()
            expect(host.locator("#phase")).to_have_text("turn start")
            expect(host.locator("#active-team")).not_to_have_text(previous_active)
            expect(host.locator("#active-team")).to_have_class(
                re.compile(r"\bmotion-turn-handoff\b"),
            )

            page.reload(wait_until="domcontentloaded")
            expect(page.locator("#lab-room")).to_have_text(room)
            host = page.frame_locator("#host-frame")
            host.locator("#game").wait_for(state="visible")
            expect(host.locator("#phase")).to_have_text("turn start")

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
        f"simulation=play+placement+reveal+bonus+next_round controller=team_to_host_to_team "
        f"motion=focus+sweep+flip+edge+handoff+ring "
        f"direct_launcher=team_a "
        f"phone_timeline=vertical actions=sticky_on_long_timeline "
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
