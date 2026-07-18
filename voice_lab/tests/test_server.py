import json
import re
from html.parser import HTMLParser
from pathlib import Path

from voice_lab.server import (
    DEFAULT_MODEL,
    build_instructions,
    build_multipart,
    build_session_config,
    load_dotenv,
    load_songs,
    normalize_client_log,
)
from voice_lab.benchmark import (
    CONFIGS,
    load_cases,
    parse_candidate_payload,
    percentile,
    summarize_results,
)


def test_catalogue_is_valid_and_unique():
    songs = load_songs()

    assert len(songs) >= 10
    assert len({song["id"] for song in songs}) == len(songs)
    assert all(song["title"] and song["artist"] for song in songs)


def test_session_is_text_only_push_to_talk_with_required_function():
    songs = load_songs()
    session = build_session_config(songs)

    assert session["model"] == DEFAULT_MODEL
    assert session["output_modalities"] == ["text"]
    assert session["max_output_tokens"] == 512
    assert session["audio"]["input"]["turn_detection"] is None
    assert session["tool_choice"] == "required"
    assert session["tools"][0]["name"] == "submit_song_guess"
    required = session["tools"][0]["parameters"]["required"]
    assert required == ["candidate_id", "heard_text", "confidence"]
    candidate_ids = session["tools"][0]["parameters"]["properties"]["candidate_id"]["enum"]
    assert candidate_ids[-1] == "none"
    assert set(candidate_ids[:-1]) == {song["id"] for song in songs}


def test_session_can_disable_openai_noise_reduction_for_low_latency():
    session = build_session_config(load_songs(), noise_reduction=None)

    assert session["audio"]["input"]["noise_reduction"] is None


def test_prompt_contains_catalogue_but_no_active_answer():
    songs = load_songs()
    instructions = build_instructions(songs)

    assert "You are not told" not in instructions
    assert "Candidate catalogue" in instructions
    assert "Call submit_song_guess immediately" in instructions
    for song in songs:
        assert song["id"] in instructions
        assert song["title"] in instructions


def test_multipart_has_sdp_and_json_session():
    session = {"type": "realtime", "model": DEFAULT_MODEL}
    body, boundary = build_multipart("v=0\r\nt=0 0", session)
    decoded = body.decode()

    assert f"--{boundary}" in decoded
    assert 'name="sdp"' in decoded
    assert "filename=" not in decoded
    assert "Content-Type: application/sdp" in decoded
    assert 'name="session"' in decoded
    assert json.dumps(session, separators=(",", ":")) in decoded
    assert decoded.endswith(f"--{boundary}--\r\n")


def test_dotenv_does_not_overwrite_existing_values(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text('OPENAI_API_KEY="from-file"\nNEW_VALUE=yes\n', encoding="utf-8")
    environ = {"OPENAI_API_KEY": "already-set"}

    load_dotenv(env_file, environ)

    assert environ["OPENAI_API_KEY"] == "already-set"
    assert environ["NEW_VALUE"] == "yes"


def test_client_telemetry_is_flat_bounded_and_allowlisted():
    event = normalize_client_log(
        {
            "type": "answer.error",
            "message": "x" * 2_000,
            "round": 4,
            "apiKey": "must-not-be-recorded",
            "nested": {"unexpected": True},
        }
    )

    assert event["type"] == "answer.error"
    assert event["round"] == 4
    assert len(event["message"]) == 1_000
    assert "apiKey" not in event
    assert "nested" not in event


class IdCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes:
            self.ids.append(attributes["id"])


def test_browser_script_only_queries_ids_present_in_html():
    public = Path(__file__).parents[1] / "public"
    parser = IdCollector()
    parser.feed((public / "index.html").read_text(encoding="utf-8"))
    queried_ids = set(
        re.findall(r"\$\('#([A-Za-z][A-Za-z0-9_-]*)'\)", (public / "app.js").read_text(encoding="utf-8"))
    )

    assert len(parser.ids) == len(set(parser.ids)), "HTML element IDs must be unique"
    assert queried_ids <= set(parser.ids)


def test_browser_uses_fast_realtime_response_path():
    app_script = (Path(__file__).parents[1] / "public" / "app.js").read_text(encoding="utf-8")

    assert "reasoning: { effort: 'minimal' }" in app_script
    assert "max_output_tokens: 512" in app_script
    assert "response.function_call_arguments.done" in app_script
    assert "setTimeout(resolve, 100)" not in app_script


def test_browser_removes_each_answer_from_realtime_history():
    app_script = (Path(__file__).parents[1] / "public" / "app.js").read_text(encoding="utf-8")

    assert "conversation: 'none'" in app_script
    assert "event.type === 'input_audio_buffer.committed'" in app_script
    assert "type: 'conversation.item.delete'" in app_script
    assert "event.type === 'conversation.item.deleted'" in app_script
    assert "cleanupCurrentInput(markAnswerReady)" in app_script


def test_benchmark_cases_and_configs_cover_latency_tradeoffs():
    cases = load_cases()

    assert {case["expected_candidate_id"] for case in cases} >= {
        "bohemian-rhapsody",
        "none",
    }
    assert CONFIGS["rt21-min-512"].reasoning_effort == "minimal"
    assert CONFIGS["rt21-low-512"].reasoning_effort == "low"
    assert CONFIGS["rt21-min-json-512"].response_mode == "json"
    assert {config.model for config in CONFIGS.values()} >= {
        "gpt-realtime-2.1-mini",
        "gpt-realtime-1.5",
        "gpt-realtime-mini",
    }


def test_benchmark_summary_ranks_reliable_accurate_low_latency_first():
    results = [
        {
            "config": "fast",
            "model": "model-a",
            "candidate_id": "song",
            "accurate": True,
            "status": "completed",
            "result_ready_ms": 500,
        },
        {
            "config": "slow",
            "model": "model-b",
            "candidate_id": "song",
            "accurate": True,
            "status": "completed",
            "result_ready_ms": 900,
        },
    ]

    summary = summarize_results(results)

    assert summary[0]["config"] == "fast"
    assert percentile([100, 200, 300], 0.9) == 280.0


def test_benchmark_extracts_json_from_imperfect_text_output():
    expected = {
        "candidate_id": "bohemian-rhapsody",
        "heard_text": "Bohemian Rhapsody",
        "confidence": 0.9,
    }

    assert parse_candidate_payload(json.dumps(expected)) == expected
    assert parse_candidate_payload(f"JSON object: ({json.dumps(expected)})") == expected
    assert parse_candidate_payload('{"candidate_id":') is None
    assert parse_candidate_payload("No structured answer") is None
