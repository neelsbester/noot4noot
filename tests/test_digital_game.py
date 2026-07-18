"""Tests for the server-authoritative digital multiplayer game."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.request import Request, urlopen

import pytest

from digital_game.server import build_server
from digital_game.service import GameError, GameService, Song, load_song_deck


def sample_songs() -> list[Song]:
    return [
        Song(
            id=f"track{year}",
            title=f"Song {year}",
            artist=f"Artist {year}",
            year=year,
            spotify_url=f"https://open.spotify.com/track/track{year}",
            spotify_uri=f"spotify:track:track{year}",
        )
        for year in (1960, 1970, 1980, 1990, 2000, 2010, 2020, 2021, 2022, 2023)
    ]


def started_game(seed: int = 3):
    service = GameService(sample_songs(), seed=seed)
    host = service.create_room()
    first = service.join_room(host["code"], "First Team")
    second = service.join_room(host["code"], "Second Team")
    host_state = service.action(host["code"], host["token"], "start_game", {})
    sessions = {first["team_id"]: first, second["team_id"]: second}
    return service, host, sessions, host_state


def correct_slot(service: GameService, room_code: str) -> int:
    room = service.rooms[room_code]
    current = room.current_round
    assert current is not None
    timeline = room.teams[current.active_team_id].timeline
    song_year = service.songs[current.song_id].year
    return next(
        slot for slot in range(len(timeline) + 1)
        if service._slot_accepts_year(timeline, slot, song_year)
    )


def test_loads_existing_song_deck():
    songs = load_song_deck(Path("songs.csv"))
    assert len(songs) >= 5
    assert songs[0].spotify_uri.startswith("spotify:track:")


def test_room_requires_two_teams_and_hides_mystery_metadata():
    service = GameService(sample_songs(), seed=1)
    host = service.create_room()
    first = service.join_room(host["code"], "Needle Drops")

    with pytest.raises(GameError, match="At least two teams"):
        service.action(host["code"], host["token"], "start_game", {})

    second = service.join_room(host["code"], "Vinyl Crew")
    host_state = service.action(host["code"], host["token"], "start_game", {})
    team_state = service.state(host["code"], first["token"])

    assert host_state["round"]["song"]["spotify_uri"].startswith("spotify:track:")
    assert "year" not in host_state["round"]["song"]
    assert team_state["round"]["song"] == {"id": "mystery"}
    assert len(team_state["viewer_timeline"]) == 1
    assert second["team_id"] != first["team_id"]


def test_first_challenger_spends_one_token_and_blocks_the_next():
    service, host, sessions, state = started_game()
    active_id = state["round"]["active_team_id"]
    challenger_id = next(team_id for team_id in sessions if team_id != active_id)
    active = sessions[active_id]
    challenger = sessions[challenger_id]
    slot = correct_slot(service, host["code"])

    service.action(host["code"], active["token"], "place", {"slot": slot})
    service.action(host["code"], active["token"], "lock_placement", {})
    challenged = service.action(host["code"], challenger["token"], "claim_challenge", {})

    challenger_view = next(team for team in challenged["teams"] if team["id"] == challenger_id)
    assert challenger_view["tokens"] == 1
    with pytest.raises(GameError, match="already claimed"):
        service.action(host["code"], challenger["token"], "claim_challenge", {})


def test_correct_active_placement_beats_wrong_challenge():
    service, host, sessions, state = started_game(seed=5)
    active_id = state["round"]["active_team_id"]
    challenger_id = next(team_id for team_id in sessions if team_id != active_id)
    active = sessions[active_id]
    challenger = sessions[challenger_id]
    right = correct_slot(service, host["code"])
    wrong = 1 - right

    service.action(host["code"], active["token"], "place", {"slot": right})
    service.action(host["code"], active["token"], "lock_placement", {})
    service.action(host["code"], challenger["token"], "claim_challenge", {})
    service.action(host["code"], challenger["token"], "place_challenge", {"slot": wrong})
    service.action(host["code"], challenger["token"], "lock_challenge", {})
    revealed = service.action(host["code"], active["token"], "reveal", {})

    assert revealed["round"]["outcome"] == "active_won"
    assert revealed["round"]["winner_team_id"] == active_id
    assert revealed["round"]["correct_placement"] == right
    assert len(revealed["active_timeline"]) == 1
    assert next(team for team in revealed["teams"] if team["id"] == active_id)["card_count"] == 2
    assert revealed["round"]["song"]["year"]


def test_correct_challenge_steals_card_from_wrong_active_placement():
    service, host, sessions, state = started_game(seed=8)
    active_id = state["round"]["active_team_id"]
    challenger_id = next(team_id for team_id in sessions if team_id != active_id)
    active = sessions[active_id]
    challenger = sessions[challenger_id]
    right = correct_slot(service, host["code"])
    wrong = 1 - right

    service.action(host["code"], active["token"], "place", {"slot": wrong})
    service.action(host["code"], active["token"], "lock_placement", {})
    service.action(host["code"], challenger["token"], "claim_challenge", {})
    service.action(host["code"], challenger["token"], "place_challenge", {"slot": right})
    service.action(host["code"], challenger["token"], "lock_challenge", {})
    revealed = service.action(host["code"], active["token"], "reveal", {})

    assert revealed["round"]["outcome"] == "challenge_won"
    assert revealed["round"]["winner_team_id"] == challenger_id
    assert revealed["round"]["correct_placement"] == right
    assert len(revealed["active_timeline"]) == 1
    assert next(team for team in revealed["teams"] if team["id"] == challenger_id)["card_count"] == 2


def test_host_can_close_unchallenged_round_and_manage_tokens():
    service, host, sessions, state = started_game(seed=4)
    active_id = state["round"]["active_team_id"]
    active = sessions[active_id]
    slot = correct_slot(service, host["code"])

    service.action(host["code"], active["token"], "place", {"slot": slot})
    service.action(host["code"], active["token"], "lock_placement", {})
    ready = service.action(host["code"], host["token"], "close_challenge", {})
    assert ready["round"]["phase"] == "reveal_ready"

    for _ in range(5):
        state = service.action(
            host["code"], host["token"], "adjust_tokens", {"team_id": active_id, "delta": 1}
        )
    assert next(team for team in state["teams"] if team["id"] == active_id)["tokens"] == 5


def test_host_can_skip_song_without_changing_round_or_active_team():
    service, host, sessions, state = started_game(seed=4)
    original_song_id = state["round"]["song"]["id"]
    active_id = state["round"]["active_team_id"]
    active = sessions[active_id]

    service.action(host["code"], active["token"], "place", {"slot": 0})
    skipped = service.action(host["code"], host["token"], "skip_song", {})

    assert skipped["round"]["song"]["id"] != original_song_id
    assert skipped["round"]["number"] == 1
    assert skipped["round"]["active_team_id"] == active_id
    assert skipped["round"]["phase"] == "placement"
    assert skipped["round"]["placement"] is None
    assert skipped["can"]["skip_song"] is True
    assert service.state(host["code"], active["token"])["can"]["skip_song"] is False


def test_team_session_can_explicitly_switch_into_cohost_mode():
    service, host, sessions, state = started_game(seed=4)
    team = next(iter(sessions.values()))
    original_song_id = state["round"]["song"]["id"]

    normal_view = service.state(host["code"], team["token"])
    assert normal_view["viewer"]["role"] == "team"
    assert normal_view["viewer"]["cohost_authorized"] is False
    assert normal_view["room"]["control_code"] is None
    assert normal_view["round"]["song"] == {"id": "mystery"}
    assert normal_view["can"]["skip_song"] is False
    with pytest.raises(GameError, match="Only the host"):
        service.action(host["code"], team["token"], "skip_song", {})

    with pytest.raises(GameError) as unauthorized:
        service.state(host["code"], team["token"], host_mode=True)
    assert unauthorized.value.code == "cohost_authorization_required"

    control_code = service.state(host["code"], host["token"])["room"]["control_code"]
    with pytest.raises(GameError) as wrong_code:
        service.action(
            host["code"], team["token"], "authorize_cohost", {"control_code": "0000"}
        )
    assert wrong_code.value.code == "invalid_control_code"

    service.action(
        host["code"], team["token"], "authorize_cohost", {"control_code": control_code}
    )
    cohost_view = service.state(host["code"], team["token"], host_mode=True)
    assert cohost_view["viewer"] == {
        "role": "cohost",
        "team_id": team["team_id"],
        "cohost_authorized": True,
    }
    assert cohost_view["round"]["song"]["spotify_uri"].startswith("spotify:track:")
    assert cohost_view["can"]["skip_song"] is True

    skipped = service.action(
        host["code"],
        team["token"],
        "skip_song",
        {},
        host_mode=True,
    )
    assert skipped["viewer"]["role"] == "cohost"
    assert skipped["round"]["song"]["id"] != original_song_id


def test_cohost_can_start_a_lobby_without_receiving_the_host_token():
    service = GameService(sample_songs(), seed=2)
    host = service.create_room()
    first = service.join_room(host["code"], "First Team")
    service.join_room(host["code"], "Second Team")
    control_code = service.state(host["code"], host["token"])["room"]["control_code"]
    service.action(
        host["code"],
        first["token"],
        "authorize_cohost",
        {"control_code": control_code},
    )

    started = service.action(
        host["code"],
        first["token"],
        "start_game",
        {},
        host_mode=True,
    )

    assert started["room"]["status"] == "playing"
    assert started["viewer"] == {
        "role": "cohost",
        "team_id": first["team_id"],
        "cohost_authorized": True,
    }
    assert first["token"] != host["token"]


def test_skipping_a_claimed_challenge_refunds_the_token():
    service, host, sessions, state = started_game(seed=7)
    active_id = state["round"]["active_team_id"]
    challenger_id = next(team_id for team_id in sessions if team_id != active_id)
    active = sessions[active_id]
    challenger = sessions[challenger_id]

    service.action(host["code"], active["token"], "place", {"slot": 0})
    service.action(host["code"], active["token"], "lock_placement", {})
    challenged = service.action(host["code"], challenger["token"], "claim_challenge", {})
    assert next(team for team in challenged["teams"] if team["id"] == challenger_id)["tokens"] == 1

    skipped = service.action(host["code"], host["token"], "skip_song", {})
    assert next(team for team in skipped["teams"] if team["id"] == challenger_id)["tokens"] == 2
    assert skipped["round"]["challenge_team_id"] is None


def test_only_rival_team_can_pass_and_close_challenge_window():
    service, host, sessions, state = started_game(seed=4)
    active_id = state["round"]["active_team_id"]
    active = sessions[active_id]
    rival_id = next(team_id for team_id in sessions if team_id != active_id)
    rival = sessions[rival_id]
    slot = correct_slot(service, host["code"])

    service.action(host["code"], active["token"], "place", {"slot": slot})
    service.action(host["code"], active["token"], "lock_placement", {})

    with pytest.raises(GameError, match="active team"):
        service.action(host["code"], active["token"], "pass_challenge", {})

    ready = service.action(host["code"], rival["token"], "pass_challenge", {})
    assert ready["round"]["phase"] == "reveal_ready"
    assert next(team for team in ready["teams"] if team["id"] == rival_id)["tokens"] == 2


def test_all_rivals_must_pass_in_a_three_team_game():
    service = GameService(sample_songs(), seed=9)
    host = service.create_room()
    teams = [service.join_room(host["code"], name) for name in ("Alpha", "Bravo", "Charlie")]
    state = service.action(host["code"], host["token"], "start_game", {})
    active_id = state["round"]["active_team_id"]
    active = next(team for team in teams if team["team_id"] == active_id)
    rivals = [team for team in teams if team["team_id"] != active_id]
    slot = correct_slot(service, host["code"])

    service.action(host["code"], active["token"], "place", {"slot": slot})
    service.action(host["code"], active["token"], "lock_placement", {})
    waiting = service.action(host["code"], rivals[0]["token"], "pass_challenge", {})

    assert waiting["round"]["phase"] == "challenge"
    assert waiting["round"]["viewer_passed"] is True
    assert waiting["round"]["challenge_pass_count"] == 1
    assert waiting["can"]["claim_challenge"] is False
    with pytest.raises(GameError, match="already passed"):
        service.action(host["code"], rivals[0]["token"], "claim_challenge", {})

    ready = service.action(host["code"], rivals[1]["token"], "pass_challenge", {})
    assert ready["round"]["phase"] == "reveal_ready"
    assert ready["round"]["challenge_pass_count"] == 2


def test_three_tokens_buy_a_random_timeline_card():
    service, host, sessions, state = started_game(seed=6)
    team_id = state["teams"][0]["id"]
    service.action(host["code"], host["token"], "adjust_tokens", {"team_id": team_id, "delta": 1})
    bought = service.action(host["code"], host["token"], "buy_random_card", {"team_id": team_id})
    team = next(team for team in bought["teams"] if team["id"] == team_id)
    assert team["tokens"] == 0
    assert team["card_count"] == 2


def test_reaching_target_finishes_game_and_gates_every_action():
    service = GameService(sample_songs(), target_cards=2, seed=5)
    host = service.create_room()
    teams = [
        service.join_room(host["code"], "First Team"),
        service.join_room(host["code"], "Second Team"),
    ]
    state = service.action(host["code"], host["token"], "start_game", {})
    active = next(team for team in teams if team["team_id"] == state["round"]["active_team_id"])
    slot = correct_slot(service, host["code"])

    service.action(host["code"], active["token"], "place", {"slot": slot})
    service.action(host["code"], active["token"], "lock_placement", {})
    service.action(host["code"], host["token"], "close_challenge", {})
    finished = service.action(host["code"], active["token"], "reveal", {})

    assert finished["room"]["status"] == "finished"
    assert finished["room"]["winner_team_id"] == active["team_id"]
    assert finished["room"]["finish_reason"] == "target_reached"
    assert finished["round"]["phase"] == "revealed"
    assert finished["can"] == {}
    with pytest.raises(GameError) as terminal_action:
        service.action(host["code"], host["token"], "next_round", {})
    assert terminal_action.value.code == "game_finished"


def test_buying_winning_card_finishes_cleanly_during_active_round():
    service = GameService(sample_songs(), starting_tokens=3, target_cards=2, seed=6)
    host = service.create_room()
    first = service.join_room(host["code"], "First Team")
    service.join_room(host["code"], "Second Team")
    service.action(host["code"], host["token"], "start_game", {})

    finished = service.action(
        host["code"],
        host["token"],
        "buy_random_card",
        {"team_id": first["team_id"]},
    )

    assert finished["room"]["status"] == "finished"
    assert finished["room"]["winner_team_id"] == first["team_id"]
    assert finished["can"] == {}
    team_view = service.state(host["code"], first["token"])
    assert team_view["room"]["winner_team_id"] == first["team_id"]
    assert team_view["can"] == {}


def test_rooms_and_authorized_cohost_sessions_survive_restart(tmp_path):
    state_path = tmp_path / "rooms.json"
    service = GameService(sample_songs(), seed=3, state_path=state_path)
    host = service.create_room()
    first = service.join_room(host["code"], "First Team")
    service.join_room(host["code"], "Second Team")
    control_code = service.state(host["code"], host["token"])["room"]["control_code"]
    service.action(
        host["code"], first["token"], "authorize_cohost", {"control_code": control_code}
    )
    started = service.action(host["code"], host["token"], "start_game", {})

    restored = GameService(sample_songs(), seed=99, state_path=state_path)
    restored_host = restored.state(host["code"], host["token"])
    restored_team = restored.state(host["code"], first["token"])
    restored_cohost = restored.state(host["code"], first["token"], host_mode=True)

    assert restored_host["room"]["revision"] == started["room"]["revision"]
    assert restored_host["round"]["song"]["id"] == started["round"]["song"]["id"]
    assert restored_team["round"]["song"] == {"id": "mystery"}
    assert restored_cohost["viewer"]["role"] == "cohost"
    assert restored_cohost["viewer"]["cohost_authorized"] is True


def test_http_server_creates_and_reads_a_room():
    server = build_server("127.0.0.1", 0, deck_path=Path("songs.csv"), seed=2)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        request = Request(
            f"{base}/api/rooms",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request) as response:
            session = json.load(response)

        state_request = Request(
            f"{base}/api/rooms/{session['code']}/state",
            headers={"Authorization": f"Bearer {session['token']}"},
        )
        with urlopen(state_request) as response:
            state = json.load(response)
        assert state["room"]["status"] == "lobby"
        assert state["viewer"]["role"] == "host"

    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
