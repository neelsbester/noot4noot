"""Tests for src.csv_parser — CSV loading, validation, and URI conversion."""

import pytest
from pathlib import Path

from src.csv_parser import (
    Song,
    _sanitize_csv_value,
    extract_spotify_track_id,
    url_to_spotify_uri,
    load_songs,
)

VALID_URL = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
VALID_TRACK_ID = "4cOdK2wGLETKBW3PvgPWqT"
VALID_URI = "spotify:track:4cOdK2wGLETKBW3PvgPWqT"


# ── Song dataclass validation ────────────────────────────────────────────

class TestSongValidation:
    def test_valid_song(self):
        song = Song(
            title="Test", artist="Artist", year=2000,
            spotify_url=VALID_URL, spotify_uri=VALID_URI,
        )
        assert song.title == "Test"
        assert song.year == 2000

    def test_empty_title_raises(self):
        with pytest.raises(ValueError, match="title cannot be empty"):
            Song(title="", artist="Artist", year=2000,
                 spotify_url=VALID_URL, spotify_uri=VALID_URI)

    def test_empty_artist_raises(self):
        with pytest.raises(ValueError, match="Artist cannot be empty"):
            Song(title="Title", artist="", year=2000,
                 spotify_url=VALID_URL, spotify_uri=VALID_URI)

    def test_year_too_low_raises(self):
        with pytest.raises(ValueError, match="out of valid range"):
            Song(title="T", artist="A", year=0,
                 spotify_url=VALID_URL, spotify_uri=VALID_URI)

    def test_year_negative_raises(self):
        with pytest.raises(ValueError, match="out of valid range"):
            Song(title="T", artist="A", year=-1,
                 spotify_url=VALID_URL, spotify_uri=VALID_URI)

    def test_year_too_high_raises(self):
        with pytest.raises(ValueError, match="out of valid range"):
            Song(title="T", artist="A", year=3000,
                 spotify_url=VALID_URL, spotify_uri=VALID_URI)

    def test_year_boundary_low_valid(self):
        song = Song(title="T", artist="A", year=1900,
                    spotify_url=VALID_URL, spotify_uri=VALID_URI)
        assert song.year == 1900

    def test_year_boundary_high_valid(self):
        song = Song(title="T", artist="A", year=2100,
                    spotify_url=VALID_URL, spotify_uri=VALID_URI)
        assert song.year == 2100


# ── CSV injection sanitization ───────────────────────────────────────────

class TestSanitizeCsvValue:
    @pytest.mark.parametrize("prefix", ["=", "+", "-", "@"])
    def test_injection_prefixes_are_escaped(self, prefix):
        result = _sanitize_csv_value(f"{prefix}cmd()")
        assert result.startswith("'")

    def test_normal_value_unchanged(self):
        assert _sanitize_csv_value("Hello World") == "Hello World"

    def test_empty_string_unchanged(self):
        assert _sanitize_csv_value("") == ""


# ── Track ID extraction ──────────────────────────────────────────────────

class TestExtractSpotifyTrackId:
    def test_from_url(self):
        assert extract_spotify_track_id(VALID_URL) == VALID_TRACK_ID

    def test_from_url_with_query_params(self):
        url = f"{VALID_URL}?si=abc123"
        assert extract_spotify_track_id(url) == VALID_TRACK_ID

    def test_from_uri(self):
        assert extract_spotify_track_id(VALID_URI) == VALID_TRACK_ID

    def test_invalid_url_raises(self):
        with pytest.raises(ValueError, match="Could not extract"):
            extract_spotify_track_id("https://example.com/not-spotify")

    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match="Could not extract"):
            extract_spotify_track_id("")


# ── URL to URI conversion ────────────────────────────────────────────────

class TestUrlToSpotifyUri:
    def test_url_converts_to_uri(self):
        assert url_to_spotify_uri(VALID_URL) == VALID_URI

    def test_uri_passthrough(self):
        assert url_to_spotify_uri(VALID_URI) == VALID_URI


# ── CSV loading ──────────────────────────────────────────────────────────

class TestLoadSongs:
    def _row(self, **overrides):
        """Return a valid CSV row dict with optional overrides."""
        base = {
            "title": "Bohemian Rhapsody",
            "artist": "Queen",
            "year": "1975",
            "spotify_url": VALID_URL,
        }
        base.update(overrides)
        return base

    def test_valid_csv(self, tmp_csv):
        path = tmp_csv([self._row()])
        songs = load_songs(path)
        assert len(songs) == 1
        assert songs[0].title == "Bohemian Rhapsody"
        assert songs[0].spotify_uri == VALID_URI

    def test_unicode_title_and_artist(self, tmp_csv):
        path = tmp_csv([self._row(title="Despacito", artist="Luis Fonsi")])
        songs = load_songs(path)
        assert songs[0].title == "Despacito"

    def test_unicode_cjk_characters(self, tmp_csv):
        path = tmp_csv([self._row(title="\u6d41\u6d6a\u4e4b\u6b4c", artist="\u5468\u6770\u4f26")])
        songs = load_songs(path)
        assert songs[0].title == "\u6d41\u6d6a\u4e4b\u6b4c"
        assert songs[0].artist == "\u5468\u6770\u4f26"

    def test_empty_title_raises(self, tmp_csv):
        path = tmp_csv([self._row(title="")])
        with pytest.raises(ValueError):
            load_songs(path)

    def test_invalid_year_non_numeric(self, tmp_csv):
        path = tmp_csv([self._row(year="unknown")])
        with pytest.raises(ValueError, match="Invalid year"):
            load_songs(path)

    def test_invalid_year_out_of_range(self, tmp_csv):
        path = tmp_csv([self._row(year="3000")])
        with pytest.raises(ValueError, match="out of valid range"):
            load_songs(path)

    def test_malformed_spotify_url(self, tmp_csv):
        path = tmp_csv([self._row(spotify_url="https://example.com/track/nope")])
        with pytest.raises(ValueError, match="Could not extract"):
            load_songs(path)

    def test_csv_injection_sanitized(self, tmp_csv):
        path = tmp_csv([self._row(title="=cmd()")])
        songs = load_songs(path)
        assert songs[0].title.startswith("'")

    def test_missing_required_columns(self, tmp_csv):
        path = tmp_csv(
            [{"title": "Song", "artist": "A"}],
            fieldnames=["title", "artist"],
        )
        with pytest.raises(ValueError, match="missing required columns"):
            load_songs(path)

    def test_empty_csv_no_rows(self, tmp_path):
        path = tmp_path / "empty.csv"
        path.write_text("title,artist,year,spotify_url\n", encoding="utf-8")
        with pytest.raises(ValueError, match="no songs"):
            load_songs(path)

    def test_file_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_songs(tmp_path / "nonexistent.csv")

    def test_multiple_songs(self, tmp_csv):
        rows = [
            self._row(title="Song A"),
            self._row(title="Song B"),
            self._row(title="Song C"),
        ]
        songs = load_songs(tmp_csv(rows))
        assert len(songs) == 3
        assert songs[2].title == "Song C"

    def test_spotify_url_to_uri_conversion(self, tmp_csv):
        path = tmp_csv([self._row()])
        songs = load_songs(path)
        assert songs[0].spotify_uri == VALID_URI
