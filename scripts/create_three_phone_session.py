"""Create an importable Noot4Noot host plus two-team test session."""

from __future__ import annotations

import argparse
import base64
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def request_json(base_url: str, path: str, *, method: str = "GET", body: dict[str, Any] | None = None, token: str = "") -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = Request(
        f"{base_url}{path}",
        data=data,
        headers={
            **({"Content-Type": "application/json"} if body is not None else {}),
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
        method=method,
    )
    try:
        with urlopen(request, timeout=10) as response:
            return json.load(response)
    except HTTPError as exc:
        try:
            message = json.load(exc).get("error", exc.reason)
        except Exception:
            message = exc.reason
        raise SystemExit(f"Noot4Noot request failed: {message}") from exc
    except URLError as exc:
        raise SystemExit(f"Noot4Noot server is unavailable at {base_url}: {exc.reason}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:5173", help="Running Noot4Noot server origin")
    parser.add_argument("--team-a", default="Needle Crew")
    parser.add_argument("--team-b", default="Bassline Club")
    parser.add_argument("--no-start", action="store_true", help="Leave the new room in the lobby")
    args = parser.parse_args()
    base_url = args.url.rstrip("/")

    request_json(base_url, "/api/health")
    host = request_json(base_url, "/api/rooms", method="POST", body={})
    room = host["code"]
    team_a = request_json(base_url, f"/api/rooms/{room}/teams", method="POST", body={"name": args.team_a})
    team_b = request_json(base_url, f"/api/rooms/{room}/teams", method="POST", body={"name": args.team_b})

    if args.no_start:
        phase = "lobby"
    else:
        state = request_json(
            base_url,
            f"/api/rooms/{room}/actions",
            method="POST",
            body={"action": "start_game"},
            token=host["token"],
        )
        phase = state["round"]["phase"]

    payload = {
        "room": room,
        "host": {"token": host["token"]},
        "teamA": {"token": team_a["token"], "teamId": team_a["team_id"]},
        "teamB": {"token": team_b["token"], "teamId": team_b["team_id"]},
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    import_url = f"{base_url}/test-lab#session={encoded}"

    verified = request_json(base_url, f"/api/rooms/{room}/state", token=host["token"])
    if len(verified["teams"]) != 2:
        raise SystemExit("Test session verification failed: expected two teams")

    print(f"ROOM={room}")
    print(f"PHASE={phase}")
    print(f"TEAM_A={args.team_a}")
    print(f"TEAM_B={args.team_b}")
    print(f"URL={import_url}")


if __name__ == "__main__":
    main()
