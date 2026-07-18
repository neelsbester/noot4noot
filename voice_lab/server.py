"""Tiny static server and secure OpenAI Realtime WebRTC session endpoint."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
SONGS_PATH = PUBLIC_DIR / "songs.json"
OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls"
DEFAULT_MODEL = "gpt-realtime-2.1-mini"
MAX_SDP_BYTES = 1_000_000
MAX_CLIENT_LOG_BYTES = 16_384
CLIENT_LOG_PATH = ROOT / "client-events.log"
CLIENT_LOG_LOCK = threading.Lock()
CLIENT_LOG_FIELDS = {
    "at",
    "type",
    "round",
    "targetId",
    "heldMs",
    "latencyMs",
    "connected",
    "status",
    "peerState",
    "code",
    "message",
    "candidateId",
    "heardText",
    "confidence",
    "verdict",
    "sourceEvent",
    "outputTypes",
    "rawArguments",
    "reason",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "resultEvent",
}


def normalize_client_log(payload: object) -> dict[str, object]:
    """Keep telemetry bounded, flat, and free of unexpected client fields."""
    if not isinstance(payload, dict) or not isinstance(payload.get("type"), str):
        raise ValueError("Client log must be an object with a type")

    normalized: dict[str, object] = {
        "serverAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    }
    for key in CLIENT_LOG_FIELDS:
        value = payload.get(key)
        if isinstance(value, str):
            normalized[key] = value[:1_000]
        elif isinstance(value, (int, float, bool)) or value is None:
            if key in payload:
                normalized[key] = value
    return normalized


def append_client_log(payload: object, path: Path = CLIENT_LOG_PATH) -> dict[str, object]:
    event = normalize_client_log(payload)
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with CLIENT_LOG_LOCK:
        with path.open("a", encoding="utf-8") as log_file:
            log_file.write(f"{line}\n")
    sys.stderr.write(f"[voice-telemetry] {line}\n")
    return event


def load_dotenv(path: Path, environ: dict[str, str] | None = None) -> dict[str, str]:
    """Load simple KEY=VALUE pairs without overwriting existing environment values."""
    target = environ if environ is not None else os.environ
    if not path.exists():
        return target

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key:
            target.setdefault(key, value)
    return target


def load_songs(path: Path = SONGS_PATH) -> list[dict[str, object]]:
    songs = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(songs, list) or not songs:
        raise ValueError("songs.json must contain at least one song")
    return songs


def build_instructions(songs: list[dict[str, object]]) -> str:
    catalogue = "\n".join(
        f"- {song['id']}: {song['title']} — {song['artist']}"
        + (f" (aliases: {', '.join(song.get('aliases', []))})" if song.get("aliases") else "")
        for song in songs
    )
    return f"""# Role
You are a fast speech matcher for a music guessing game.

# Rules
- Call submit_song_guess immediately. Do not produce ordinary text or a preamble.
- Match a clearly spoken song title, artist, or both, allowing minor pronunciation errors.
- An artist-only answer identifies a candidate when that artist has exactly one catalogue entry.
- Infer only what was spoken. Background audio is not an answer.
- Use candidate_id \"none\" for silence, unclear speech, an ambiguous artist, or an answer outside the catalogue.
- Keep heard_text short and confidence calibrated from 0 to 1.

Candidate catalogue:
{catalogue}
"""


def build_session_config(
    songs: list[dict[str, object]],
    model: str = DEFAULT_MODEL,
    noise_reduction: str | None = "near_field",
) -> dict[str, object]:
    candidate_ids = [str(song["id"]) for song in songs] + ["none"]
    return {
        "type": "realtime",
        "model": model,
        "output_modalities": ["text"],
        "instructions": build_instructions(songs),
        "max_output_tokens": 512,
        "audio": {
            "input": {
                "turn_detection": None,
                "noise_reduction": (
                    {"type": noise_reduction} if noise_reduction else None
                ),
            }
        },
        "tools": [
            {
                "type": "function",
                "name": "submit_song_guess",
                "description": "Return the song answer understood from the user's speech.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "candidate_id": {
                            "type": "string",
                            "enum": candidate_ids,
                            "description": "Best matching catalogue ID, or none.",
                        },
                        "heard_text": {
                            "type": "string",
                            "description": "A concise transcript of the spoken answer.",
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                    },
                    "required": [
                        "candidate_id",
                        "heard_text",
                        "confidence",
                    ],
                    "additionalProperties": False,
                },
            }
        ],
        "tool_choice": "required",
    }


def build_multipart(sdp: str, session: Mapping[str, object]) -> tuple[bytes, str]:
    boundary = f"----noot4noot-{secrets.token_hex(16)}"
    session_json = json.dumps(session, separators=(",", ":"))
    sections = [
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="sdp"\r\n'
            "Content-Type: application/sdp\r\n\r\n"
            f"{sdp}\r\n"
        ),
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="session"\r\n'
            "Content-Type: application/json\r\n\r\n"
            f"{session_json}\r\n"
        ),
        f"--{boundary}--\r\n",
    ]
    return "".join(sections).encode("utf-8"), boundary


class VoiceLabHandler(SimpleHTTPRequestHandler):
    server_version = "Noot4NootVoiceLab/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Permissions-Policy",
            "microphone=(self), camera=(), geolocation=()",
        )
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self' https://api.openai.com; img-src 'self' data:; "
            "media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/config":
            self._send_json(
                HTTPStatus.OK,
                {
                    "apiKeyConfigured": bool(os.environ.get("OPENAI_API_KEY")),
                    "model": os.environ.get("OPENAI_REALTIME_MODEL", DEFAULT_MODEL),
                },
            )
            return
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/client-log":
            self._receive_client_log()
            return
        if self.path != "/api/realtime/session":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not api_key or api_key.startswith("sk-your-"):
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "error": "OPENAI_API_KEY is not configured",
                    "hint": "Copy voice_lab/.env.example to voice_lab/.env and add your project key.",
                },
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_SDP_BYTES:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid SDP payload size"})
            return

        sdp = self.rfile.read(length).decode("utf-8", errors="strict")
        if not sdp.startswith("v=0"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid SDP offer"})
            return

        model = os.environ.get("OPENAI_REALTIME_MODEL", DEFAULT_MODEL)
        noise_reduction_setting = os.environ.get(
            "OPENAI_INPUT_NOISE_REDUCTION", "off"
        ).strip().lower()
        noise_reduction = (
            noise_reduction_setting
            if noise_reduction_setting in {"near_field", "far_field"}
            else None
        )
        session = build_session_config(load_songs(), model, noise_reduction)
        body, boundary = build_multipart(sdp, session)
        request = urllib.request.Request(
            OPENAI_CALLS_URL,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "OpenAI-Safety-Identifier": "noot4noot-voice-lab-local",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                answer_sdp = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", "application/sdp")
                self.send_header("Content-Length", str(len(answer_sdp)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(answer_sdp)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(detail)
                message = parsed.get("error", {}).get("message", detail)
            except json.JSONDecodeError:
                message = detail
            self._send_json(error.code, {"error": message})
        except (urllib.error.URLError, TimeoutError) as error:
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": f"Could not reach OpenAI: {error.reason if hasattr(error, 'reason') else error}"},
            )

    def _receive_client_log(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_CLIENT_LOG_BYTES:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid client log size"})
            return

        try:
            payload = json.loads(self.rfile.read(length))
            append_client_log(payload)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        self._send_json(HTTPStatus.ACCEPTED, {"accepted": True})

    def _send_json(self, status: int, payload: Mapping[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write(f"[voice-lab] {self.address_string()} {format % args}\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Noot4Noot voice answer lab")
    parser.add_argument("--host", default=os.environ.get("VOICE_LAB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("VOICE_LAB_PORT", "8787")))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    load_dotenv(ROOT / ".env")
    args = parse_args(argv)
    mimetypes.add_type("text/javascript", ".js")
    server = ThreadingHTTPServer((args.host, args.port), VoiceLabHandler)
    print(f"Noot4Noot Voice Lab: http://{args.host}:{args.port}")
    print(f"Client telemetry: {CLIENT_LOG_PATH}")
    if not os.environ.get("OPENAI_API_KEY"):
        print("OpenAI is not configured yet; copy .env.example to .env and add your key.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping voice lab.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
