"""Dependency-free HTTP server for local Noot4Noot multiplayer games."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .service import GameError, GameService, load_song_deck


PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = Path(__file__).resolve().parent / "web"
DEFAULT_DECK = (
    PROJECT_ROOT / "white_people_turnt_shuffled.csv"
    if (PROJECT_ROOT / "white_people_turnt_shuffled.csv").exists()
    else PROJECT_ROOT / "songs.csv"
)


def _load_env_value(name: str) -> str:
    if os.environ.get(name):
        return os.environ[name]
    for path in (PROJECT_ROOT / "player" / ".env", PROJECT_ROOT / ".env"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line or line.lstrip().startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() == name:
                return value.strip().strip('"\'')
    return ""


def _local_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return str(sock.getsockname()[0])
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


class GameHTTPServer(ThreadingHTTPServer):
    service: GameService
    public_port: int
    spotify_client_id: str
    public_url: str


class GameRequestHandler(BaseHTTPRequestHandler):
    server: GameHTTPServer

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                self._json({"ok": True})
                return
            if path == "/api/config":
                self._json(
                    {
                        "spotify_client_id": self.server.spotify_client_id,
                        "lan_url": self.server.public_url or f"http://{_local_ip()}:{self.server.public_port}",
                    }
                )
                return
            if path.startswith("/api/rooms/") and path.endswith("/state"):
                code = path.split("/")[3]
                self._json(self.server.service.state(code, self._token()))
                return
            self._serve_static(path)
        except GameError as exc:
            self._game_error(exc)
        except Exception:
            traceback.print_exc()
            self._json({"error": "Internal server error", "code": "server_error"}, status=500)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._request_json()
            if path == "/api/rooms":
                self._json(self.server.service.create_room(), status=HTTPStatus.CREATED)
                return
            if path.startswith("/api/rooms/") and path.endswith("/teams"):
                code = path.split("/")[3]
                self._json(
                    self.server.service.join_room(code, str(body.get("name", ""))),
                    status=HTTPStatus.CREATED,
                )
                return
            if path.startswith("/api/rooms/") and path.endswith("/actions"):
                code = path.split("/")[3]
                action = str(body.pop("action", ""))
                self._json(self.server.service.action(code, self._token(), action, body))
                return
            self._json({"error": "Route not found", "code": "not_found"}, status=404)
        except GameError as exc:
            self._game_error(exc)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json({"error": "Invalid JSON request", "code": "invalid_json"}, status=400)
        except Exception:
            traceback.print_exc()
            self._json({"error": "Internal server error", "code": "server_error"}, status=500)

    def _serve_static(self, path: str) -> None:
        route_map = {
            "/": "index.html",
            "/host": "host.html",
            "/host/": "host.html",
            "/callback": "host.html",
            "/team": "team.html",
            "/team/": "team.html",
            "/test-lab": "test-lab.html",
            "/test-lab/": "test-lab.html",
        }
        relative = route_map.get(path, path.lstrip("/"))
        candidate = (WEB_ROOT / relative).resolve()
        if WEB_ROOT.resolve() not in candidate.parents and candidate != WEB_ROOT.resolve():
            self._json({"error": "Not found", "code": "not_found"}, status=404)
            return
        if not candidate.is_file():
            self._json({"error": "Not found", "code": "not_found"}, status=404)
            return

        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        data = candidate.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") or content_type.endswith("javascript") else content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _request_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise GameError("Invalid Content-Length", code="invalid_request") from exc
        if length > 65_536:
            raise GameError("Request is too large", status=413, code="request_too_large")
        if length == 0:
            return {}
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(body, dict):
            raise GameError("Request body must be a JSON object", code="invalid_request")
        return body

    def _token(self) -> str:
        authorization = self.headers.get("Authorization", "")
        if authorization.startswith("Bearer "):
            return authorization[7:]
        return ""

    def _game_error(self, error: GameError) -> None:
        self._json({"error": str(error), "code": error.code}, status=error.status)

    def _json(self, payload: dict[str, Any], *, status: int | HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")


def build_server(
    host: str,
    port: int,
    *,
    deck_path: Path,
    starting_tokens: int = 2,
    target_cards: int = 10,
    seed: int | None = None,
) -> GameHTTPServer:
    songs = load_song_deck(deck_path)
    service = GameService(
        songs,
        starting_tokens=starting_tokens,
        target_cards=target_cards,
        seed=seed,
    )
    server = GameHTTPServer((host, port), GameRequestHandler)
    server.service = service
    server.public_port = port
    server.spotify_client_id = _load_env_value("VITE_SPOTIFY_CLIENT_ID")
    server.public_url = ""
    return server


def start_quick_tunnel(port: int) -> tuple[subprocess.Popen[str], str]:
    """Start a development-only TryCloudflare tunnel and return its public URL."""

    binary = shutil.which("cloudflared")
    if not binary:
        raise RuntimeError("cloudflared is not installed or not available on PATH")
    process = subprocess.Popen(
        [binary, "tunnel", "--url", f"http://localhost:{port}", "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None
    url_pattern = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
    for line_number, line in enumerate(process.stdout, start=1):
        print(f"  tunnel: {line.rstrip()}")
        match = url_pattern.search(line)
        if match:
            return process, match.group(0)
        if line_number >= 120:
            break
    process.terminate()
    raise RuntimeError("cloudflared did not return a Quick Tunnel URL")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Noot4Noot multiplayer game server")
    parser.add_argument("--host", default="0.0.0.0", help="Address to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=5173, help="Port to serve (default: 5173)")
    parser.add_argument("--deck", type=Path, default=DEFAULT_DECK, help="Song CSV deck")
    parser.add_argument("--starting-tokens", type=int, default=2)
    parser.add_argument("--target-cards", type=int, default=10)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--quick-tunnel", action="store_true", help="Create a temporary HTTPS URL for phone/iPad testing")
    parser.add_argument("--public-url", default="", help="Existing public HTTPS URL to show to joining devices")
    args = parser.parse_args()

    server = build_server(
        args.host,
        args.port,
        deck_path=args.deck,
        starting_tokens=args.starting_tokens,
        target_cards=args.target_cards,
        seed=args.seed,
    )
    tunnel_process: subprocess.Popen[str] | None = None
    lan_url = args.public_url or f"http://{_local_ip()}:{args.port}"
    if args.quick_tunnel:
        tunnel_process, lan_url = start_quick_tunnel(args.port)
    server.public_url = lan_url
    print("Noot4Noot digital game is ready")
    print(f"  Host on this PC: http://127.0.0.1:{args.port}")
    print(f"  Phone / iPad:    {lan_url}")
    print(f"  Songs loaded:    {len(server.service.songs)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping game server")
    finally:
        server.server_close()
        if tunnel_process:
            tunnel_process.terminate()
            try:
                tunnel_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                tunnel_process.kill()


if __name__ == "__main__":
    main()
