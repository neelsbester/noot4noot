"""Tests for src.qr_generator — QR code image generation."""

import pytest
from PIL import Image

from src.qr_generator import generate_qr_code, generate_spotify_qr


VALID_URI = "spotify:track:4cOdK2wGLETKBW3PvgPWqT"


class TestGenerateQrCode:
    def test_returns_pil_image(self):
        img = generate_qr_code(VALID_URI)
        assert isinstance(img, Image.Image)

    def test_default_size(self):
        img = generate_qr_code(VALID_URI)
        assert img.size == (200, 200)

    def test_custom_size(self):
        img = generate_qr_code(VALID_URI, size=300)
        assert img.size == (300, 300)

    def test_inverted_returns_rgba(self):
        img = generate_qr_code(VALID_URI, inverted=True)
        assert img.mode == "RGBA"

    def test_normal_mode(self):
        img = generate_qr_code(VALID_URI, inverted=False)
        # Normal mode is either RGB or L (not RGBA)
        assert img.mode in ("RGB", "L", "1", "P")

    def test_very_long_uri(self):
        """QR can encode long strings — version auto-adjusts via fit=True."""
        long_data = "spotify:track:" + "a" * 200
        img = generate_qr_code(long_data, size=400)
        assert img.size == (400, 400)


class TestGenerateSpotifyQr:
    def test_delegates_to_generate_qr_code(self):
        img = generate_spotify_qr(VALID_URI, size=150)
        assert isinstance(img, Image.Image)
        assert img.size == (150, 150)

    def test_inverted_spotify_qr(self):
        img = generate_spotify_qr(VALID_URI, inverted=True)
        assert img.mode == "RGBA"
