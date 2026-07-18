"""Server-authoritative game state for the Noot4Noot digital mode."""

from __future__ import annotations

import csv
import json
import random
import re
import secrets
import string
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TRACK_ID_PATTERN = re.compile(r"(?:spotify\.com/track/|spotify:track:)([A-Za-z0-9]+)")


class GameError(Exception):
    """A safe, user-facing game rule or request error."""

    def __init__(self, message: str, *, status: int = 400, code: str = "game_error"):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Song:
    id: str
    title: str
    artist: str
    year: int
    spotify_url: str
    spotify_uri: str

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "year": self.year,
            "spotify_url": self.spotify_url,
            "spotify_uri": self.spotify_uri,
        }


@dataclass
class Team:
    id: str
    name: str
    session_token: str
    tokens: int
    timeline: list[str] = field(default_factory=list)


@dataclass
class Round:
    number: int
    song_id: str
    active_team_id: str
    phase: str = "placement"
    placement: int | None = None
    challenge_team_id: str | None = None
    challenge_placement: int | None = None
    challenge_pass_team_ids: set[str] = field(default_factory=set)
    correct_placement: int | None = None
    reveal_timeline_song_ids: list[str] | None = None
    outcome: str | None = None
    winner_team_id: str | None = None


@dataclass
class Room:
    code: str
    host_token: str
    deck: list[str]
    starting_tokens: int
    target_cards: int
    control_code: str
    status: str = "lobby"
    teams: dict[str, Team] = field(default_factory=dict)
    team_order: list[str] = field(default_factory=list)
    active_team_index: int = 0
    current_round: Round | None = None
    used_song_ids: set[str] = field(default_factory=set)
    cohost_team_ids: set[str] = field(default_factory=set)
    winner_team_id: str | None = None
    finish_reason: str | None = None
    revision: int = 0


def load_song_deck(csv_path: Path) -> list[Song]:
    """Load a playable song deck from a Noot4Noot CSV file."""

    if not csv_path.exists():
        raise FileNotFoundError(f"Song deck not found: {csv_path}")

    songs: list[Song] = []
    seen_ids: set[str] = set()

    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"title", "artist", "year", "spotify_url"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            missing = sorted(required - set(reader.fieldnames or []))
            raise ValueError(f"Song deck is missing columns: {', '.join(missing)}")

        for row_number, row in enumerate(reader, start=2):
            spotify_url = row["spotify_url"].strip()
            match = TRACK_ID_PATTERN.search(spotify_url)
            if not match:
                raise ValueError(f"Row {row_number} has an invalid Spotify track URL")

            track_id = match.group(1)
            if track_id in seen_ids:
                continue

            try:
                year = int(row["year"].strip())
            except ValueError as exc:
                raise ValueError(f"Row {row_number} has an invalid year") from exc

            if not 1900 <= year <= 2100:
                raise ValueError(f"Row {row_number} has a year outside 1900-2100")

            title = row["title"].strip()
            artist = row["artist"].strip()
            if not title or not artist:
                raise ValueError(f"Row {row_number} is missing a title or artist")

            seen_ids.add(track_id)
            songs.append(
                Song(
                    id=track_id,
                    title=title,
                    artist=artist,
                    year=year,
                    spotify_url=spotify_url,
                    spotify_uri=f"spotify:track:{track_id}",
                )
            )

    if len(songs) < 5:
        raise ValueError("A digital game deck needs at least 5 unique songs")
    return songs


class GameService:
    """Thread-safe game service with optional file-backed room recovery."""

    def __init__(
        self,
        songs: list[Song],
        *,
        starting_tokens: int = 2,
        target_cards: int = 10,
        seed: int | None = None,
        state_path: Path | None = None,
    ):
        if starting_tokens < 0:
            raise ValueError("starting_tokens cannot be negative")
        if target_cards < 2:
            raise ValueError("target_cards must be at least 2")

        self.songs = {song.id: song for song in songs}
        self.starting_tokens = starting_tokens
        self.target_cards = target_cards
        self.state_path = state_path
        self.rooms: dict[str, Room] = {}
        self._rng = random.Random(seed)
        self._lock = threading.RLock()
        self._load_rooms()

    def create_room(self) -> dict[str, str]:
        with self._lock:
            code = self._new_room_code()
            deck = list(self.songs)
            self._rng.shuffle(deck)
            room = Room(
                code=code,
                host_token=secrets.token_urlsafe(24),
                deck=deck,
                starting_tokens=self.starting_tokens,
                target_cards=self.target_cards,
                control_code=f"{secrets.randbelow(10_000):04d}",
            )
            self.rooms[code] = room
            self._persist_rooms()
            return {"code": code, "token": room.host_token, "role": "host"}

    def join_room(self, code: str, name: str) -> dict[str, str]:
        with self._lock:
            room = self._room(code)
            if room.status != "lobby":
                raise GameError("This game has already started", code="game_started")
            if len(room.teams) >= 8:
                raise GameError("This room already has 8 teams", code="room_full")

            clean_name = " ".join(name.strip().split())
            if not 2 <= len(clean_name) <= 28:
                raise GameError("Team name must be 2-28 characters", code="invalid_team_name")
            if any(team.name.casefold() == clean_name.casefold() for team in room.teams.values()):
                raise GameError("That team name is already in use", code="duplicate_team_name")

            team_id = secrets.token_hex(5)
            team = Team(
                id=team_id,
                name=clean_name,
                session_token=secrets.token_urlsafe(24),
                tokens=room.starting_tokens,
            )
            room.teams[team_id] = team
            room.team_order.append(team_id)
            self._touch(room)
            self._persist_rooms()
            return {"code": room.code, "token": team.session_token, "role": "team", "team_id": team.id}

    def state(self, code: str, token: str, *, host_mode: bool = False) -> dict[str, Any]:
        with self._lock:
            room = self._room(code)
            role, team_id = self._authenticate(room, token, host_mode=host_mode)
            return self._serialize(room, role, team_id)

    def action(
        self,
        code: str,
        token: str,
        action: str,
        payload: dict[str, Any],
        *,
        host_mode: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            room = self._room(code)
            role, team_id = self._authenticate(room, token, host_mode=host_mode)

            handlers = {
                "start_game": self._start_game,
                "place": self._place,
                "lock_placement": self._lock_placement,
                "claim_challenge": self._claim_challenge,
                "pass_challenge": self._pass_challenge,
                "place_challenge": self._place_challenge,
                "lock_challenge": self._lock_challenge,
                "close_challenge": self._close_challenge,
                "skip_song": self._skip_song,
                "reveal": self._reveal,
                "next_round": self._next_round,
                "adjust_tokens": self._adjust_tokens,
                "buy_random_card": self._buy_random_card,
                "authorize_cohost": self._authorize_cohost,
            }
            handler = handlers.get(action)
            if not handler:
                raise GameError("Unknown game action", code="unknown_action")
            if room.status == "finished":
                raise GameError("This game is finished", code="game_finished")

            handler(room, role, team_id, payload)
            self._touch(room)
            self._persist_rooms()
            return self._serialize(room, role, team_id)

    def _authorize_cohost(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        self._require_team(role, team_id)
        supplied_code = str(payload.get("control_code", "")).strip()
        if not supplied_code or not secrets.compare_digest(supplied_code, room.control_code):
            raise GameError("That host control code is not correct", status=403, code="invalid_control_code")
        room.cohost_team_ids.add(team_id)

    def _start_game(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        self._require_host(role)
        if room.status != "lobby":
            raise GameError("The game has already started")
        if len(room.teams) < 2:
            raise GameError("At least two teams must join before starting")
        if len(room.deck) < len(room.teams) + 1:
            raise GameError("The song deck is too small for this number of teams")

        room.status = "playing"
        for joined_team_id in room.team_order:
            starter = self._draw_song(room)
            room.teams[joined_team_id].timeline.append(starter.id)
        room.active_team_index = 0
        self._begin_round(room, number=1)

    def _place(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_team(role, team_id)
        if current.phase != "placement" or team_id != current.active_team_id:
            raise GameError("Only the active team can place this card", code="not_active_team")
        current.placement = self._validated_slot(room, current, payload.get("slot"))

    def _lock_placement(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_team(role, team_id)
        if current.phase != "placement" or team_id != current.active_team_id:
            raise GameError("Only the active team can lock this placement", code="not_active_team")
        if current.placement is None:
            raise GameError("Choose a timeline gap before locking in", code="placement_required")
        current.phase = "challenge"

    def _claim_challenge(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_team(role, team_id)
        if current.phase != "challenge":
            raise GameError("The challenge window is not open", code="challenge_closed")
        if team_id == current.active_team_id:
            raise GameError("The active team cannot challenge itself", code="active_team_challenge")
        if current.challenge_team_id:
            raise GameError("Another team already claimed this challenge", status=409, code="challenge_claimed")
        if team_id in current.challenge_pass_team_ids:
            raise GameError("Your team already passed this challenge", code="challenge_passed")

        team = room.teams[team_id]
        if team.tokens < 1:
            raise GameError("You need at least one token to challenge", code="not_enough_tokens")
        team.tokens -= 1
        current.challenge_team_id = team_id

    def _pass_challenge(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_team(role, team_id)
        if current.phase != "challenge" or current.challenge_team_id:
            raise GameError("The challenge window is no longer open", code="challenge_closed")
        if team_id == current.active_team_id:
            raise GameError("The active team cannot pass its own challenge window", code="active_team_pass")
        if team_id in current.challenge_pass_team_ids:
            raise GameError("Your team already passed this challenge", code="challenge_passed")

        current.challenge_pass_team_ids.add(team_id)
        rival_team_ids = set(room.team_order) - {current.active_team_id}
        if current.challenge_pass_team_ids >= rival_team_ids:
            current.phase = "reveal_ready"

    def _place_challenge(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_team(role, team_id)
        if current.phase != "challenge" or team_id != current.challenge_team_id:
            raise GameError("Only the team holding the challenge can place it", code="not_challenger")
        slot = self._validated_slot(room, current, payload.get("slot"))
        if slot == current.placement:
            raise GameError("A challenge must choose a different position", code="same_challenge_slot")
        current.challenge_placement = slot

    def _lock_challenge(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_team(role, team_id)
        if current.phase != "challenge" or team_id != current.challenge_team_id:
            raise GameError("Only the challenging team can lock this position", code="not_challenger")
        if current.challenge_placement is None:
            raise GameError("Choose a challenge position first", code="challenge_placement_required")
        current.phase = "reveal_ready"

    def _close_challenge(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        self._require_host(role)
        if current.phase != "challenge":
            raise GameError("The challenge window is not open")
        if current.challenge_team_id:
            raise GameError("The challenging team must lock its position")
        current.phase = "reveal_ready"

    def _skip_song(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        self._require_host(role)
        current = self._current_round(room)
        if room.status != "playing" or current.phase == "revealed":
            raise GameError("Start the next round instead of skipping a revealed card", code="cannot_skip_song")
        if not room.deck:
            raise GameError("The song deck is empty", code="deck_empty")

        if current.challenge_team_id:
            challenger = room.teams[current.challenge_team_id]
            challenger.tokens = min(5, challenger.tokens + 1)

        self._begin_round(room, number=current.number)

    def _reveal(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        current = self._current_round(room)
        if current.phase != "reveal_ready":
            raise GameError("The round is not ready to reveal", code="not_reveal_ready")
        if role not in {"host", "cohost"} and team_id != current.active_team_id:
            raise GameError("Only the host or active team can reveal", code="cannot_reveal")

        song = self.songs[current.song_id]
        active_team = room.teams[current.active_team_id]
        current.reveal_timeline_song_ids = list(active_team.timeline)
        active_correct = self._slot_accepts_year(active_team.timeline, current.placement, song.year)
        challenger_correct = False
        if current.challenge_team_id and current.challenge_placement is not None:
            challenger_correct = self._slot_accepts_year(
                active_team.timeline, current.challenge_placement, song.year
            )

        if active_correct:
            current.correct_placement = current.placement
        elif challenger_correct:
            current.correct_placement = current.challenge_placement
        else:
            current.correct_placement = self._canonical_slot(active_team.timeline, song)

        if active_correct:
            current.outcome = "active_won"
            current.winner_team_id = active_team.id
            self._insert_song(active_team, song.id)
        elif challenger_correct and current.challenge_team_id:
            current.outcome = "challenge_won"
            current.winner_team_id = current.challenge_team_id
            self._insert_song(room.teams[current.challenge_team_id], song.id)
        else:
            current.outcome = "no_winner"

        current.phase = "revealed"
        winning_team = next(
            (team for team in room.teams.values() if len(team.timeline) >= room.target_cards),
            None,
        )
        if winning_team:
            self._finish(room, winner_team_id=winning_team.id, reason="target_reached")
        elif not room.deck:
            self._finish(room, winner_team_id=None, reason="deck_empty")

    def _next_round(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        self._require_host(role)
        current = self._current_round(room)
        if room.status == "finished":
            raise GameError("The game already has a winner", code="game_finished")
        if current.phase != "revealed":
            raise GameError("Reveal the current card before starting another round")
        if not room.deck:
            self._finish(room, winner_team_id=None, reason="deck_empty")
            return

        room.status = "playing"
        room.active_team_index = (room.active_team_index + 1) % len(room.team_order)
        self._begin_round(room, number=current.number + 1)

    def _adjust_tokens(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        self._require_host(role)
        target = self._team(room, payload.get("team_id"))
        try:
            delta = int(payload.get("delta"))
        except (TypeError, ValueError) as exc:
            raise GameError("Token adjustment must be a number") from exc
        if delta not in {-1, 1}:
            raise GameError("Token adjustment must be +1 or -1")
        target.tokens = min(5, max(0, target.tokens + delta))

    def _buy_random_card(self, room: Room, role: str, team_id: str | None, payload: dict[str, Any]) -> None:
        self._require_host(role)
        target = self._team(room, payload.get("team_id"))
        if room.status != "playing":
            raise GameError("Start the game before buying cards")
        if target.tokens < 3:
            raise GameError("That team needs 3 tokens to buy a card", code="not_enough_tokens")
        if not room.deck:
            raise GameError("The song deck is empty", code="deck_empty")

        target.tokens -= 3
        song = self._draw_song(room)
        self._insert_song(target, song.id)
        if len(target.timeline) >= room.target_cards:
            self._finish(room, winner_team_id=target.id, reason="target_reached")

    @staticmethod
    def _finish(room: Room, *, winner_team_id: str | None, reason: str) -> None:
        room.status = "finished"
        room.winner_team_id = winner_team_id
        room.finish_reason = reason

    def _begin_round(self, room: Room, *, number: int) -> None:
        song = self._draw_song(room)
        room.current_round = Round(
            number=number,
            song_id=song.id,
            active_team_id=room.team_order[room.active_team_index],
        )

    def _draw_song(self, room: Room) -> Song:
        if not room.deck:
            raise GameError("The song deck is empty", code="deck_empty")
        song_id = room.deck.pop()
        room.used_song_ids.add(song_id)
        return self.songs[song_id]

    def _insert_song(self, team: Team, song_id: str) -> None:
        team.timeline.append(song_id)
        team.timeline.sort(key=lambda item: (self.songs[item].year, self.songs[item].title.casefold()))

    def _slot_accepts_year(self, timeline: list[str], slot: int | None, year: int) -> bool:
        if slot is None or not 0 <= slot <= len(timeline):
            return False
        lower = self.songs[timeline[slot - 1]].year if slot > 0 else None
        upper = self.songs[timeline[slot]].year if slot < len(timeline) else None
        return (lower is None or lower <= year) and (upper is None or year <= upper)

    def _canonical_slot(self, timeline: list[str], song: Song) -> int:
        song_key = (song.year, song.title.casefold())
        return sum(
            (self.songs[song_id].year, self.songs[song_id].title.casefold()) <= song_key
            for song_id in timeline
        )

    def _validated_slot(self, room: Room, current: Round, value: Any) -> int:
        try:
            slot = int(value)
        except (TypeError, ValueError) as exc:
            raise GameError("Timeline slot must be a number", code="invalid_slot") from exc
        timeline_length = len(room.teams[current.active_team_id].timeline)
        if not 0 <= slot <= timeline_length:
            raise GameError("That timeline position no longer exists", code="invalid_slot")
        return slot

    def _serialize(self, room: Room, role: str, viewer_team_id: str | None) -> dict[str, Any]:
        current = room.current_round
        viewer_is_host = role in {"host", "cohost"}
        active_team_id = current.active_team_id if current else None
        active_timeline = room.teams[active_team_id].timeline if active_team_id else []
        if current and current.phase == "revealed" and current.reveal_timeline_song_ids is not None:
            active_timeline = current.reveal_timeline_song_ids
        viewer_timeline = room.teams[viewer_team_id].timeline if viewer_team_id else []

        result: dict[str, Any] = {
            "room": {
                "code": room.code,
                "status": room.status,
                "revision": room.revision,
                "starting_tokens": room.starting_tokens,
                "target_cards": room.target_cards,
                "winner_team_id": room.winner_team_id,
                "finish_reason": room.finish_reason,
                "control_code": room.control_code if role == "host" else None,
            },
            "viewer": {
                "role": role,
                "team_id": viewer_team_id,
                "cohost_authorized": bool(
                    viewer_team_id and viewer_team_id in room.cohost_team_ids
                ),
            },
            "teams": [
                {
                    "id": joined_team_id,
                    "name": room.teams[joined_team_id].name,
                    "tokens": room.teams[joined_team_id].tokens,
                    "card_count": len(room.teams[joined_team_id].timeline),
                    "is_active": joined_team_id == active_team_id,
                }
                for joined_team_id in room.team_order
            ],
            "round": None,
            "active_timeline": [self.songs[song_id].public_dict() for song_id in active_timeline],
            "viewer_timeline": [self.songs[song_id].public_dict() for song_id in viewer_timeline],
            "can": {},
        }

        if current:
            show_active_placement = (
                viewer_is_host
                or viewer_team_id == current.active_team_id
                or current.phase != "placement"
            )
            show_challenge_placement = (
                viewer_is_host
                or viewer_team_id == current.challenge_team_id
                or current.phase in {"reveal_ready", "revealed"}
            )
            song: dict[str, Any]
            if current.phase == "revealed":
                song = self.songs[current.song_id].public_dict()
            elif viewer_is_host:
                hidden_song = self.songs[current.song_id]
                song = {
                    "id": hidden_song.id,
                    "spotify_uri": hidden_song.spotify_uri,
                    "spotify_url": hidden_song.spotify_url,
                }
            else:
                song = {"id": "mystery"}

            result["round"] = {
                "number": current.number,
                "phase": current.phase,
                "active_team_id": current.active_team_id,
                "placement": current.placement if show_active_placement else None,
                "challenge_team_id": current.challenge_team_id,
                "challenge_placement": current.challenge_placement if show_challenge_placement else None,
                "challenge_pass_count": len(current.challenge_pass_team_ids),
                "challenge_pass_total": max(0, len(room.teams) - 1),
                "viewer_passed": viewer_team_id in current.challenge_pass_team_ids,
                "correct_placement": current.correct_placement,
                "outcome": current.outcome,
                "winner_team_id": current.winner_team_id,
                "song": song,
            }

            if room.status == "finished":
                return result

            viewer_is_team = role == "team" and viewer_team_id is not None
            result["can"] = {
                "place": viewer_is_team and viewer_team_id == current.active_team_id and current.phase == "placement",
                "lock_placement": viewer_is_team and viewer_team_id == current.active_team_id and current.phase == "placement" and current.placement is not None,
                "claim_challenge": viewer_is_team and viewer_team_id != current.active_team_id and viewer_team_id not in current.challenge_pass_team_ids and current.phase == "challenge" and current.challenge_team_id is None and room.teams[viewer_team_id].tokens > 0,
                "pass_challenge": viewer_is_team and viewer_team_id != current.active_team_id and viewer_team_id not in current.challenge_pass_team_ids and current.phase == "challenge" and current.challenge_team_id is None,
                "place_challenge": viewer_is_team and viewer_team_id == current.challenge_team_id and current.phase == "challenge",
                "lock_challenge": viewer_is_team and viewer_team_id == current.challenge_team_id and current.phase == "challenge" and current.challenge_placement is not None,
                "close_challenge": viewer_is_host and current.phase == "challenge" and current.challenge_team_id is None,
                "skip_song": viewer_is_host and room.status == "playing" and current.phase != "revealed" and bool(room.deck),
                "reveal": current.phase == "reveal_ready" and (viewer_is_host or viewer_team_id == current.active_team_id),
                "next_round": viewer_is_host and current.phase == "revealed" and room.status != "finished",
            }
        else:
            result["can"] = {"start_game": viewer_is_host and len(room.teams) >= 2}

        return result

    def _authenticate(
        self,
        room: Room,
        token: str,
        *,
        host_mode: bool = False,
    ) -> tuple[str, str | None]:
        if token and secrets.compare_digest(token, room.host_token):
            return "host", None
        for team in room.teams.values():
            if token and secrets.compare_digest(token, team.session_token):
                if host_mode and team.id not in room.cohost_team_ids:
                    raise GameError(
                        "Enter the host control code before opening host controls",
                        status=403,
                        code="cohost_authorization_required",
                    )
                return ("cohost" if host_mode else "team"), team.id
        raise GameError("This game session is no longer valid", status=401, code="invalid_session")

    def _persist_rooms(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "rooms": [self._room_to_dict(room) for room in self.rooms.values()],
        }
        temporary_path = self.state_path.with_suffix(f"{self.state_path.suffix}.tmp")
        temporary_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary_path.replace(self.state_path)
        self.state_path.chmod(0o600)

    def _load_rooms(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            if payload.get("version") != 1:
                raise ValueError("unsupported state version")
            for room_data in payload.get("rooms", []):
                room = self._room_from_dict(room_data)
                referenced_song_ids = set(room.deck) | room.used_song_ids
                referenced_song_ids.update(
                    song_id for team in room.teams.values() for song_id in team.timeline
                )
                if room.current_round:
                    referenced_song_ids.add(room.current_round.song_id)
                    referenced_song_ids.update(room.current_round.reveal_timeline_song_ids or [])
                if not referenced_song_ids <= self.songs.keys():
                    raise ValueError(f"room {room.code} references songs missing from this deck")
                self.rooms[room.code] = room
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            self.rooms.clear()
            print(f"Warning: could not restore digital game rooms: {exc}")

    @staticmethod
    def _room_to_dict(room: Room) -> dict[str, Any]:
        current = room.current_round
        return {
            "code": room.code,
            "host_token": room.host_token,
            "deck": room.deck,
            "starting_tokens": room.starting_tokens,
            "target_cards": room.target_cards,
            "control_code": room.control_code,
            "status": room.status,
            "teams": {
                team_id: {
                    "id": team.id,
                    "name": team.name,
                    "session_token": team.session_token,
                    "tokens": team.tokens,
                    "timeline": team.timeline,
                }
                for team_id, team in room.teams.items()
            },
            "team_order": room.team_order,
            "active_team_index": room.active_team_index,
            "current_round": None if not current else {
                "number": current.number,
                "song_id": current.song_id,
                "active_team_id": current.active_team_id,
                "phase": current.phase,
                "placement": current.placement,
                "challenge_team_id": current.challenge_team_id,
                "challenge_placement": current.challenge_placement,
                "challenge_pass_team_ids": sorted(current.challenge_pass_team_ids),
                "correct_placement": current.correct_placement,
                "reveal_timeline_song_ids": current.reveal_timeline_song_ids,
                "outcome": current.outcome,
                "winner_team_id": current.winner_team_id,
            },
            "used_song_ids": sorted(room.used_song_ids),
            "cohost_team_ids": sorted(room.cohost_team_ids),
            "winner_team_id": room.winner_team_id,
            "finish_reason": room.finish_reason,
            "revision": room.revision,
        }

    @staticmethod
    def _room_from_dict(data: dict[str, Any]) -> Room:
        teams = {
            team_id: Team(
                id=team_data["id"],
                name=team_data["name"],
                session_token=team_data["session_token"],
                tokens=int(team_data["tokens"]),
                timeline=list(team_data.get("timeline", [])),
            )
            for team_id, team_data in data.get("teams", {}).items()
        }
        round_data = data.get("current_round")
        current_round = None if not round_data else Round(
            number=int(round_data["number"]),
            song_id=round_data["song_id"],
            active_team_id=round_data["active_team_id"],
            phase=round_data.get("phase", "placement"),
            placement=round_data.get("placement"),
            challenge_team_id=round_data.get("challenge_team_id"),
            challenge_placement=round_data.get("challenge_placement"),
            challenge_pass_team_ids=set(round_data.get("challenge_pass_team_ids", [])),
            correct_placement=round_data.get("correct_placement"),
            reveal_timeline_song_ids=round_data.get("reveal_timeline_song_ids"),
            outcome=round_data.get("outcome"),
            winner_team_id=round_data.get("winner_team_id"),
        )
        return Room(
            code=data["code"],
            host_token=data["host_token"],
            deck=list(data.get("deck", [])),
            starting_tokens=int(data["starting_tokens"]),
            target_cards=int(data["target_cards"]),
            control_code=str(data["control_code"]),
            status=data.get("status", "lobby"),
            teams=teams,
            team_order=list(data.get("team_order", [])),
            active_team_index=int(data.get("active_team_index", 0)),
            current_round=current_round,
            used_song_ids=set(data.get("used_song_ids", [])),
            cohost_team_ids=set(data.get("cohost_team_ids", [])),
            winner_team_id=data.get("winner_team_id"),
            finish_reason=data.get("finish_reason"),
            revision=int(data.get("revision", 0)),
        )

    def _new_room_code(self) -> str:
        for _ in range(100):
            code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(4))
            if code not in self.rooms:
                return code
        raise RuntimeError("Unable to allocate a room code")

    def _room(self, code: str) -> Room:
        normalized = str(code).strip().upper()
        room = self.rooms.get(normalized)
        if not room:
            raise GameError("Room not found", status=404, code="room_not_found")
        return room

    @staticmethod
    def _touch(room: Room) -> None:
        room.revision += 1

    @staticmethod
    def _current_round(room: Room) -> Round:
        if not room.current_round:
            raise GameError("The game has not started", code="game_not_started")
        return room.current_round

    @staticmethod
    def _require_host(role: str) -> None:
        if role not in {"host", "cohost"}:
            raise GameError("Only the host can do that", status=403, code="host_only")

    @staticmethod
    def _require_team(role: str, team_id: str | None) -> None:
        if role != "team" or not team_id:
            raise GameError("Only a team can do that", status=403, code="team_only")

    @staticmethod
    def _team(room: Room, team_id: Any) -> Team:
        team = room.teams.get(str(team_id))
        if not team:
            raise GameError("Team not found", status=404, code="team_not_found")
        return team
