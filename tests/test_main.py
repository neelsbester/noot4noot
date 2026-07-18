"""Tests for CLI helper commands."""

import csv
from argparse import Namespace

from src.main import cmd_shuffle


def _read_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_shuffle_preserves_header_and_rows(tmp_csv, tmp_path, capsys):
    input_path = tmp_csv([
        {
            "title": "Song A",
            "artist": "Artist A",
            "year": "2001",
            "spotify_url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
        },
        {
            "title": "Song B",
            "artist": "Artist B",
            "year": "2002",
            "spotify_url": "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
        },
        {
            "title": "Song C",
            "artist": "Artist C",
            "year": "2003",
            "spotify_url": "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
        },
    ])
    output_path = tmp_path / "shuffled.csv"

    cmd_shuffle(Namespace(input=str(input_path), output=str(output_path), seed=7))

    with open(output_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        assert next(reader) == ["title", "artist", "year", "spotify_url"]

    original_titles = sorted(row["title"] for row in _read_rows(input_path))
    shuffled_titles = sorted(row["title"] for row in _read_rows(output_path))
    assert shuffled_titles == original_titles
    assert "Shuffled 3 songs" in capsys.readouterr().out


def test_shuffle_seed_is_reproducible(tmp_csv, tmp_path):
    input_path = tmp_csv([
        {"title": f"Song {idx}", "artist": "A", "year": "2000",
         "spotify_url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"}
        for idx in range(10)
    ])
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"

    cmd_shuffle(Namespace(input=str(input_path), output=str(first), seed=42))
    cmd_shuffle(Namespace(input=str(input_path), output=str(second), seed=42))

    assert first.read_text(encoding="utf-8") == second.read_text(encoding="utf-8")
