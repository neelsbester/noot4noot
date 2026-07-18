"""Repeatable OpenAI Realtime latency and accuracy benchmark for the voice lab."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import random
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from array import array

from voice_lab.server import ROOT, build_session_config, load_dotenv, load_songs


CASES_PATH = ROOT / "benchmark_cases.json"
ARTIFACTS_DIR = ROOT / "benchmark_artifacts"
FIXTURES_DIR = ARTIFACTS_DIR / "fixtures"
RESULTS_DIR = ARTIFACTS_DIR / "results"
OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime"
PCM_BYTES_PER_SECOND = 24_000 * 2
SILENCE_MS = 80
AMBIENT_NOISE_AMPLITUDE = 400
AMBIENT_TONE_AMPLITUDE = 250


@dataclass(frozen=True)
class BenchmarkConfig:
    name: str
    model: str
    reasoning_effort: str | None
    max_output_tokens: int
    noise_reduction: bool = True
    response_mode: str = "function"


CONFIGS = {
    config.name: config
    for config in [
        BenchmarkConfig("rt21-min-256", "gpt-realtime-2.1-mini", "minimal", 256),
        BenchmarkConfig("rt21-min-512", "gpt-realtime-2.1-mini", "minimal", 512),
        BenchmarkConfig("rt21-low-512", "gpt-realtime-2.1-mini", "low", 512),
        BenchmarkConfig(
            "rt21-min-512-no-nr", "gpt-realtime-2.1-mini", "minimal", 512, False
        ),
        BenchmarkConfig("rt15-256", "gpt-realtime-1.5", None, 256),
        BenchmarkConfig("rtmini-256", "gpt-realtime-mini", None, 256),
        BenchmarkConfig(
            "rt21-min-json-512",
            "gpt-realtime-2.1-mini",
            "minimal",
            512,
            response_mode="json",
        ),
        BenchmarkConfig(
            "rt15-json-128", "gpt-realtime-1.5", None, 128, response_mode="json"
        ),
        BenchmarkConfig(
            "rtmini-json-128", "gpt-realtime-mini", None, 128, response_mode="json"
        ),
    ]
}

VOICE_PROFILES = [
    {
        "id": "coral-za",
        "voice": "coral",
        "instructions": (
            "Speak naturally in a South African English accent as a contestant giving "
            "a quick, confident music quiz answer. Do not add or remove words."
        ),
    },
    {
        "id": "onyx-neutral",
        "voice": "onyx",
        "instructions": (
            "Speak naturally in a neutral English accent as a contestant giving a quick "
            "music quiz answer. Do not add or remove words."
        ),
    },
]


def load_cases() -> list[dict[str, str]]:
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases:
        raise ValueError("benchmark_cases.json must contain at least one case")
    return cases


def require_api_key() -> str:
    load_dotenv(ROOT / ".env")
    import os

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key or api_key.startswith("sk-your-"):
        raise RuntimeError("OPENAI_API_KEY is not configured in voice_lab/.env")
    return api_key


def fixture_path(case_id: str, profile_id: str) -> Path:
    return FIXTURES_DIR / f"{case_id}--{profile_id}.pcm"


def generate_pcm_fixture(
    api_key: str,
    case: dict[str, str],
    profile: dict[str, str],
    overwrite: bool = False,
) -> dict[str, Any]:
    path = fixture_path(case["id"], profile["id"])
    if not path.exists() or overwrite:
        payload = json.dumps(
            {
                "model": "gpt-4o-mini-tts",
                "voice": profile["voice"],
                "input": case["text"],
                "instructions": profile["instructions"],
                "response_format": "pcm",
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            OPENAI_TTS_URL,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "OpenAI-Safety-Identifier": "noot4noot-voice-benchmark",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                audio = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"TTS fixture generation failed: {detail}") from error

        silence = b"\x00" * int(PCM_BYTES_PER_SECOND * SILENCE_MS / 1_000)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(silence + audio + silence)

    size = path.stat().st_size
    return {
        **case,
        "profile_id": profile["id"],
        "acoustic_profile": "clean",
        "voice": profile["voice"],
        "path": str(path),
        "duration_ms": round(size / PCM_BYTES_PER_SECOND * 1_000),
    }


def generate_ambient_fixture(clean: dict[str, Any], overwrite: bool = False) -> dict[str, Any]:
    """Create deterministic room-noise audio without another paid TTS request."""
    clean_path = Path(clean["path"])
    path = clean_path.with_name(f"{clean_path.stem}--ambient.pcm")
    if not path.exists() or overwrite:
        samples = array("h", clean_path.read_bytes())
        seed = int.from_bytes(
            hashlib.sha256(clean_path.name.encode("utf-8")).digest()[:8], "big"
        )
        rng = random.Random(seed)
        for index, sample in enumerate(samples):
            white = rng.randint(-AMBIENT_NOISE_AMPLITUDE, AMBIENT_NOISE_AMPLITUDE)
            tone = round(
                AMBIENT_TONE_AMPLITUDE
                * math.sin(2 * math.pi * 180 * index / 24_000)
            )
            samples[index] = max(-32_768, min(32_767, sample + white + tone))
        path.write_bytes(samples.tobytes())
    return {
        **clean,
        "acoustic_profile": "ambient",
        "path": str(path),
    }


def prepare_fixtures(api_key: str, overwrite: bool = False) -> list[dict[str, Any]]:
    clean_fixtures = [
        generate_pcm_fixture(api_key, case, profile, overwrite)
        for case in load_cases()
        for profile in VOICE_PROFILES
    ]
    fixtures = [
        fixture
        for clean in clean_fixtures
        for fixture in (clean, generate_ambient_fixture(clean, overwrite))
    ]
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS_DIR / "fixture-manifest.json").write_text(
        json.dumps(fixtures, indent=2), encoding="utf-8"
    )
    return fixtures


def load_fixtures() -> list[dict[str, Any]]:
    manifest = ARTIFACTS_DIR / "fixture-manifest.json"
    if not manifest.exists():
        raise RuntimeError("Fixtures are missing; run the benchmark prepare command first")
    fixtures = json.loads(manifest.read_text(encoding="utf-8"))
    missing = [fixture["path"] for fixture in fixtures if not Path(fixture["path"]).exists()]
    if missing:
        raise RuntimeError(f"Fixture files are missing: {', '.join(missing)}")
    return fixtures


def build_benchmark_session(config: BenchmarkConfig) -> dict[str, Any]:
    session = build_session_config(load_songs(), config.model)
    session.pop("max_output_tokens", None)
    session["audio"]["input"]["format"] = {"type": "audio/pcm", "rate": 24_000}
    if not config.noise_reduction:
        session["audio"]["input"]["noise_reduction"] = None
    if config.response_mode == "json":
        session["instructions"] = build_json_instructions(load_songs())
        session["tools"] = []
        session["tool_choice"] = "none"
    return session


def build_json_instructions(songs: list[dict[str, Any]]) -> str:
    catalogue = "\n".join(
        f"- {song['id']}: {song['title']} — {song['artist']}"
        for song in songs
    )
    return f"""You are a fast speech matcher for a music guessing game.
Return immediately with exactly one JSON object and no Markdown or extra text:
{{"candidate_id":"catalogue-id-or-none","heard_text":"short transcript","confidence":0.0}}
Match a clear title, artist, or both, allowing minor pronunciation errors.
An artist-only answer identifies a candidate when that artist has exactly one catalogue entry.
Use candidate_id "none" for silence, unclear speech, ambiguity, or an answer outside the catalogue.

Candidate catalogue:
{catalogue}
"""


def response_create_event(config: BenchmarkConfig, run_id: str) -> dict[str, Any]:
    response: dict[str, Any] = {
        "conversation": "none",
        "output_modalities": ["text"],
        "max_output_tokens": config.max_output_tokens,
        "metadata": {"benchmark_run": run_id},
    }
    if config.response_mode == "function":
        response["tool_choice"] = {"type": "function", "name": "submit_song_guess"}
    else:
        response["tool_choice"] = "none"
    if config.reasoning_effort:
        response["reasoning"] = {"effort": config.reasoning_effort}
        response["parallel_tool_calls"] = False
    return {"type": "response.create", "response": response}


def _connect_websocket(api_key: str, config: BenchmarkConfig):
    try:
        import websocket
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "websocket-client is required; install voice_lab/requirements-benchmark.txt"
        ) from error

    url = f"{OPENAI_REALTIME_URL}?{urllib.parse.urlencode({'model': config.model})}"
    socket = websocket.create_connection(
        url,
        header=[
            f"Authorization: Bearer {api_key}",
            "OpenAI-Safety-Identifier: noot4noot-voice-benchmark",
        ],
        timeout=30,
    )
    socket.settimeout(30)
    return socket


def _send(socket, event: dict[str, Any]) -> None:
    socket.send(json.dumps(event, separators=(",", ":")))


def _receive(socket) -> dict[str, Any]:
    event = json.loads(socket.recv())
    if event.get("type") == "error":
        error = event.get("error", {})
        raise RuntimeError(error.get("message") or json.dumps(error))
    return event


def parse_candidate_payload(text: str) -> dict[str, Any] | None:
    """Extract the first complete JSON object from a model response."""
    start = text.find("{")
    if start < 0:
        return None
    try:
        payload, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or "candidate_id" not in payload:
        return None
    return payload


def wait_for_event(socket, event_type: str) -> dict[str, Any]:
    while True:
        event = _receive(socket)
        if event.get("type") == event_type:
            return event


def run_fixture(
    socket,
    config: BenchmarkConfig,
    fixture: dict[str, Any],
    repeat: int,
) -> dict[str, Any]:
    audio = Path(fixture["path"]).read_bytes()
    _send(socket, {"type": "input_audio_buffer.clear"})
    _send(
        socket,
        {
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(audio).decode("ascii"),
        },
    )

    run_id = (
        f"{fixture['id']}-{fixture['profile_id']}-"
        f"{fixture.get('acoustic_profile', 'clean')}-{repeat}"
    )
    started = time.perf_counter()
    _send(socket, {"type": "input_audio_buffer.commit"})
    _send(socket, response_create_event(config, run_id))

    committed_item_id = None
    response_created_ms = None
    first_argument_ms = None
    arguments_done_ms = None
    text_done_ms = None
    result_ready_ms = None
    arguments = None
    argument_text = ""
    output_text = ""
    done_event = None

    while done_event is None:
        event = _receive(socket)
        elapsed_ms = round((time.perf_counter() - started) * 1_000, 1)
        event_type = event.get("type")
        if event_type == "input_audio_buffer.committed":
            committed_item_id = event.get("item_id")
        elif event_type == "response.created" and response_created_ms is None:
            response_created_ms = elapsed_ms
        elif event_type == "response.function_call_arguments.delta":
            if first_argument_ms is None:
                first_argument_ms = elapsed_ms
            argument_text += event.get("delta", "")
            parsed = parse_candidate_payload(argument_text)
            if parsed is not None and result_ready_ms is None:
                arguments = parsed
                result_ready_ms = elapsed_ms
        elif event_type == "response.function_call_arguments.done":
            arguments_done_ms = elapsed_ms
            if event.get("name") == "submit_song_guess":
                parsed = parse_candidate_payload(event.get("arguments", ""))
                if parsed is not None:
                    arguments = parsed
                    if result_ready_ms is None:
                        result_ready_ms = elapsed_ms
        elif event_type == "response.output_text.delta":
            output_text += event.get("delta", "")
            parsed = parse_candidate_payload(output_text)
            if parsed is not None and result_ready_ms is None:
                arguments = parsed
                result_ready_ms = elapsed_ms
        elif event_type == "response.output_text.done":
            text_done_ms = elapsed_ms
            parsed = parse_candidate_payload(event.get("text", ""))
            if parsed is not None:
                arguments = parsed
                if result_ready_ms is None:
                    result_ready_ms = elapsed_ms
        elif event_type == "response.done":
            done_event = event

    if committed_item_id:
        _send(socket, {"type": "conversation.item.delete", "item_id": committed_item_id})

    response = done_event.get("response", {})
    if arguments is None:
        call = next(
            (
                item
                for item in response.get("output", [])
                if item.get("type") == "function_call"
                and item.get("name") == "submit_song_guess"
            ),
            None,
        )
        if call:
            arguments = parse_candidate_payload(call.get("arguments", ""))
        if arguments is None:
            message = next(
                (item for item in response.get("output", []) if item.get("type") == "message"),
                None,
            )
            text_part = next(
                (
                    part
                    for part in (message or {}).get("content", [])
                    if part.get("type") == "output_text"
                ),
                None,
            )
            if text_part:
                arguments = parse_candidate_payload(text_part.get("text", ""))
                if arguments is not None and result_ready_ms is None:
                    result_ready_ms = round((time.perf_counter() - started) * 1_000, 1)

    candidate_id = arguments.get("candidate_id") if isinstance(arguments, dict) else None
    status_details = response.get("status_details") or {}
    usage = response.get("usage") or {}
    output = response.get("output") or []
    return {
        "config": config.name,
        "model": config.model,
        "case_id": fixture["id"],
        "profile_id": fixture["profile_id"],
        "acoustic_profile": fixture.get("acoustic_profile", "clean"),
        "text": fixture["text"],
        "expected_candidate_id": fixture["expected_candidate_id"],
        "candidate_id": candidate_id,
        "heard_text": arguments.get("heard_text") if isinstance(arguments, dict) else None,
        "confidence": arguments.get("confidence") if isinstance(arguments, dict) else None,
        "accurate": candidate_id == fixture["expected_candidate_id"],
        "status": response.get("status"),
        "reason": status_details.get("reason"),
        "status_error": status_details.get("error"),
        "output_types": [item.get("type") for item in output],
        "response_output": output,
        "repeat": repeat,
        "audio_duration_ms": fixture["duration_ms"],
        "response_created_ms": response_created_ms,
        "first_argument_ms": first_argument_ms,
        "arguments_done_ms": arguments_done_ms,
        "text_done_ms": text_done_ms,
        "result_ready_ms": result_ready_ms,
        "response_done_ms": round((time.perf_counter() - started) * 1_000, 1),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "total_tokens": usage.get("total_tokens"),
    }


def run_config(
    api_key: str,
    config: BenchmarkConfig,
    fixtures: Iterable[dict[str, Any]],
    repeats: int,
    delay_ms: int = 0,
) -> list[dict[str, Any]]:
    fixtures = list(fixtures)
    socket = _connect_websocket(api_key, config)
    results: list[dict[str, Any]] = []
    try:
        wait_for_event(socket, "session.created")
        _send(socket, {"type": "session.update", "session": build_benchmark_session(config)})
        wait_for_event(socket, "session.updated")
        for repeat in range(1, repeats + 1):
            for fixture in fixtures:
                results.append(run_fixture(socket, config, fixture, repeat))
                result = results[-1]
                print(
                    f"{config.name:22} {fixture['id']:20} {fixture['profile_id']:13} "
                    f"{fixture.get('acoustic_profile', 'clean'):7} "
                    f"{str(result['candidate_id']):22} {result['result_ready_ms']} ms "
                    f"[{result['status']}]"
                )
                if delay_ms:
                    time.sleep(delay_ms / 1_000)
    finally:
        socket.close()
    return results


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return round(ordered[lower] * (1 - weight) + ordered[upper] * weight, 1)


def summarize_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries = []
    for name in sorted({result["config"] for result in results}):
        group = [result for result in results if result["config"] == name]
        completed = [result for result in group if result.get("status") == "completed"]
        latencies = [
            result["result_ready_ms"]
            for result in completed
            if isinstance(result.get("result_ready_ms"), (int, float))
        ]
        parsed = [result for result in completed if result.get("candidate_id") is not None]
        summaries.append(
            {
                "config": name,
                "model": group[0]["model"],
                "attempts": len(group),
                "reliability_pct": round(len(parsed) / len(completed) * 100, 1)
                if completed
                else 0.0,
                "accuracy_pct": round(
                    sum(bool(result["accurate"]) for result in completed)
                    / len(completed)
                    * 100,
                    1,
                )
                if completed
                else 0.0,
                "median_ms": round(statistics.median(latencies), 1) if latencies else None,
                "p90_ms": percentile(latencies, 0.9),
                "min_ms": round(min(latencies), 1) if latencies else None,
                "incomplete": sum(result.get("status") == "incomplete" for result in group),
                "provider_failures": sum(result.get("status") == "failed" for result in group),
            }
        )
    return sorted(
        summaries,
        key=lambda item: (
            -item["reliability_pct"],
            -item["accuracy_pct"],
            item["median_ms"] if item["median_ms"] is not None else float("inf"),
        ),
    )


def print_summary(summaries: list[dict[str, Any]]) -> None:
    print("\nconfig                 rel%   acc%   median   p90    min   failed")
    for item in summaries:
        print(
            f"{item['config']:22} {item['reliability_pct']:5.1f} "
            f"{item['accuracy_pct']:6.1f} {str(item['median_ms']):>8} "
            f"{str(item['p90_ms']):>6} {str(item['min_ms']):>6} "
            f"{item['provider_failures']:>6}"
        )


def write_results(
    selected: list[BenchmarkConfig],
    results: list[dict[str, Any]],
    errors: list[dict[str, str]],
) -> Path:
    summaries = summarize_results(results)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "configs": [asdict(config) for config in selected],
        "summary": summaries,
        "errors": errors,
        "results": results,
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = RESULTS_DIR / f"benchmark-{timestamp}.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (RESULTS_DIR / "latest.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print_summary(summaries)
    if errors:
        print("\nUnavailable configurations:")
        for error in errors:
            print(f"- {error['config']}: {error['error']}")
    print(f"\nFull results: {path}")
    return path


def parse_config_names(raw: str) -> list[BenchmarkConfig]:
    names = list(CONFIGS) if raw == "all" else [name.strip() for name in raw.split(",")]
    unknown = [name for name in names if name not in CONFIGS]
    if unknown:
        raise ValueError(f"Unknown configurations: {', '.join(unknown)}")
    return [CONFIGS[name] for name in names]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare", help="Generate deterministic PCM fixtures")
    prepare.add_argument("--overwrite", action="store_true")
    sweep = subparsers.add_parser("sweep", help="Run the latency and accuracy sweep")
    sweep.add_argument("--configs", default="all", help="Comma-separated config names or all")
    sweep.add_argument("--repeats", type=int, default=1)
    sweep.add_argument(
        "--delay-ms",
        type=int,
        default=350,
        help="Pause between trials to avoid project token-per-minute limits",
    )
    sweep.add_argument(
        "--acoustic-profile",
        choices=("all", "clean", "ambient"),
        default="all",
    )
    sweep.add_argument("--prepare", action="store_true", help="Create missing fixtures first")
    subparsers.add_parser("list", help="List available configurations")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.command == "list":
        for config in CONFIGS.values():
            print(json.dumps(asdict(config), separators=(",", ":")))
        return

    api_key = require_api_key()
    if args.command == "prepare":
        fixtures = prepare_fixtures(api_key, args.overwrite)
        print(f"Prepared {len(fixtures)} fixtures in {FIXTURES_DIR}")
        return

    if args.prepare and not (ARTIFACTS_DIR / "fixture-manifest.json").exists():
        prepare_fixtures(api_key)
    fixtures = load_fixtures()
    if args.acoustic_profile != "all":
        fixtures = [
            fixture
            for fixture in fixtures
            if fixture.get("acoustic_profile", "clean") == args.acoustic_profile
        ]
    selected = parse_config_names(args.configs)
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for config in selected:
        print(f"\nRunning {config.name} ({config.model})")
        try:
            results.extend(
                run_config(api_key, config, fixtures, args.repeats, args.delay_ms)
            )
        except Exception as error:  # Keep the remaining model sweep running.
            errors.append({"config": config.name, "error": str(error)})
            print(f"Configuration failed: {error}")
    write_results(selected, results, errors)


if __name__ == "__main__":
    main()
