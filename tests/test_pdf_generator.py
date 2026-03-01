"""Tests for src.pdf_generator — decade themes, text truncation, layout math."""

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth

from src.pdf_generator import (
    get_decade_theme,
    _truncate_to_width,
    calculate_cards_per_page,
    CARD_WIDTH,
    CARD_HEIGHT,
    MARGIN,
    DECADE_THEMES,
    TITLE_FONT,
    TITLE_FONT_SIZE,
)


# ── Decade theme resolution ──────────────────────────────────────────────

class TestGetDecadeTheme:
    def test_year_in_2020s(self):
        theme = get_decade_theme(2025)
        assert theme["name"] == "2020s"

    def test_year_exactly_2020(self):
        theme = get_decade_theme(2020)
        assert theme["name"] == "2020s"

    def test_year_in_1970s(self):
        theme = get_decade_theme(1975)
        assert theme["name"] == "1970s"

    def test_year_exactly_1950(self):
        theme = get_decade_theme(1950)
        assert theme["name"] == "1950s"

    def test_year_before_1950_is_pre(self):
        theme = get_decade_theme(1940)
        assert theme["name"] == "pre-1950s"

    def test_very_old_year(self):
        theme = get_decade_theme(1900)
        assert theme["name"] == "pre-1950s"

    def test_theme_has_primary_and_accent(self):
        theme = get_decade_theme(2010)
        assert "primary" in theme
        assert "light_accent" in theme


# ── Text truncation ──────────────────────────────────────────────────────

class TestTruncateToWidth:
    def test_short_string_unchanged(self):
        result = _truncate_to_width("Hi", TITLE_FONT, TITLE_FONT_SIZE, 200)
        assert result == "Hi"

    def test_long_string_truncated_with_ellipsis(self):
        long_text = "A" * 200
        result = _truncate_to_width(long_text, TITLE_FONT, TITLE_FONT_SIZE, 50)
        assert result.endswith("...")
        assert len(result) < len(long_text)

    def test_truncated_fits_within_budget(self):
        long_text = "This Is A Very Long Song Title That Should Be Truncated"
        max_w = 60
        result = _truncate_to_width(long_text, TITLE_FONT, TITLE_FONT_SIZE, max_w)
        actual_width = stringWidth(result, TITLE_FONT, TITLE_FONT_SIZE)
        assert actual_width <= max_w

    def test_empty_string(self):
        result = _truncate_to_width("", TITLE_FONT, TITLE_FONT_SIZE, 50)
        assert result == ""


# ── Cards-per-page layout ────────────────────────────────────────────────

class TestCalculateCardsPerPage:
    def test_a4_layout(self):
        cols, rows = calculate_cards_per_page(*A4)
        # A4 is 595 x 842 pt; card is 2.5 in = 180 pt; margin 0.5 in = 36 pt
        # usable_width ≈ 523 → 2 cols; usable_height ≈ 770 → 4 rows
        assert cols >= 2
        assert rows >= 4

    def test_tiny_page_fits_nothing(self):
        cols, rows = calculate_cards_per_page(100, 100)
        assert cols == 0 or rows == 0

    def test_exact_fit(self):
        """A page sized to exactly fit one card plus margins."""
        w = CARD_WIDTH + 2 * MARGIN
        h = CARD_HEIGHT + 2 * MARGIN
        cols, rows = calculate_cards_per_page(w, h)
        assert cols == 1
        assert rows == 1
