"""Tests for src.spotify_importer — retry logic and year extraction."""

import pytest
from unittest.mock import MagicMock, patch

from src.spotify_importer import _call_with_retry, extract_playlist_id


# ── Fake SpotifyException for mocking ────────────────────────────────────

class FakeSpotifyException(Exception):
    """Mimics spotipy.exceptions.SpotifyException for tests."""

    def __init__(self, http_status, headers=None, msg=""):
        self.http_status = http_status
        self.headers = headers or {}
        super().__init__(msg)


# Patch the SpotifyException reference used inside _call_with_retry
@pytest.fixture(autouse=True)
def _patch_spotify_exception(monkeypatch):
    """Make _call_with_retry catch our FakeSpotifyException."""
    monkeypatch.setattr(
        "src.spotify_importer.SpotifyException", FakeSpotifyException
    )


# ── _call_with_retry ─────────────────────────────────────────────────────

class TestCallWithRetry:
    def test_success_on_first_call(self):
        fn = MagicMock(return_value="ok")
        result = _call_with_retry(fn)
        assert result == "ok"
        assert fn.call_count == 1

    @patch("src.spotify_importer.time.sleep")
    def test_retries_on_429(self, mock_sleep):
        fn = MagicMock(
            side_effect=[
                FakeSpotifyException(429, {"Retry-After": "1"}),
                "ok",
            ]
        )
        result = _call_with_retry(fn, max_retries=5)
        assert result == "ok"
        assert fn.call_count == 2
        mock_sleep.assert_called_once_with(1.0)

    def test_non_429_error_raised_immediately(self):
        fn = MagicMock(side_effect=FakeSpotifyException(500))
        with pytest.raises(FakeSpotifyException):
            _call_with_retry(fn)
        assert fn.call_count == 1

    @patch("src.spotify_importer.time.sleep")
    def test_exhausted_retries_makes_final_call(self, mock_sleep):
        fn = MagicMock(side_effect=FakeSpotifyException(429, {"Retry-After": "0"}))
        with pytest.raises(FakeSpotifyException):
            _call_with_retry(fn, max_retries=2)
        # 2 retries + 1 final attempt = 3 calls
        assert fn.call_count == 3

    @patch("src.spotify_importer.time.sleep")
    def test_retry_after_header_respected(self, mock_sleep):
        fn = MagicMock(
            side_effect=[
                FakeSpotifyException(429, {"Retry-After": "7"}),
                "ok",
            ]
        )
        _call_with_retry(fn, max_retries=5)
        mock_sleep.assert_called_once_with(7.0)


# ── extract_playlist_id ─────────────────────────────────────────────────

class TestExtractPlaylistId:
    def test_from_url(self):
        url = "https://open.spotify.com/playlist/0Dsp6i8lvmcTg5aiusjnFH"
        assert extract_playlist_id(url) == "0Dsp6i8lvmcTg5aiusjnFH"

    def test_from_url_with_params(self):
        url = "https://open.spotify.com/playlist/0Dsp6i8lvmcTg5aiusjnFH?si=abc"
        assert extract_playlist_id(url) == "0Dsp6i8lvmcTg5aiusjnFH"

    def test_from_uri(self):
        uri = "spotify:playlist:0Dsp6i8lvmcTg5aiusjnFH"
        assert extract_playlist_id(uri) == "0Dsp6i8lvmcTg5aiusjnFH"

    def test_raw_id(self):
        assert extract_playlist_id("0Dsp6i8lvmcTg5aiusjnFH") == "0Dsp6i8lvmcTg5aiusjnFH"

    def test_invalid_raises(self):
        with pytest.raises(ValueError, match="Could not extract"):
            extract_playlist_id("not-a-playlist")
