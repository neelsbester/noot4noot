"""Shared test fixtures for the Noot4Noot test suite."""

import csv
import tempfile
from pathlib import Path

import pytest

from src.csv_parser import Song


@pytest.fixture
def tmp_csv(tmp_path):
    """Factory fixture that writes rows to a temporary CSV and returns its Path.

    Usage:
        path = tmp_csv([
            {"title": "Song", "artist": "Artist", "year": "2020",
             "spotify_url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"},
        ])
    """

    def _write(rows, fieldnames=None):
        if fieldnames is None:
            fieldnames = ["title", "artist", "year", "spotify_url"]
        path = tmp_path / "test_songs.csv"
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        return path

    return _write


@pytest.fixture
def sample_song():
    """Return a well-formed Song instance for tests that just need a valid song."""
    return Song(
        title="Bohemian Rhapsody",
        artist="Queen",
        year=1975,
        spotify_url="https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
        spotify_uri="spotify:track:4u7EnebtmKWzUH433cf5Qv",
    )
