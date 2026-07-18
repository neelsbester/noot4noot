"""Tests for src.pdf_generator — decade themes, text truncation, layout math."""

import pytest
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth

from src.pdf_generator import (
    get_decade_theme,
    _truncate_to_width,
    calculate_cards_per_page,
    calculate_grid_origin,
    front_card_position,
    back_card_position,
    CARD_SIZE_MM,
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
        # usable_width ≈ 523 → 2 cols; usable_height ≈ 770 → 4 rows
        assert cols == 3
        assert rows == 4

    def test_default_card_size_is_60mm_square(self):
        assert CARD_SIZE_MM == 60
        assert CARD_WIDTH == pytest.approx(60 * mm)
        assert CARD_HEIGHT == pytest.approx(60 * mm)

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


class TestDuplexAlignment:
    def test_back_positions_are_horizontally_mirrored_for_short_edge_duplex(self):
        cols, rows = calculate_cards_per_page(*A4)
        start_x, start_y = calculate_grid_origin(A4[0], A4[1], cols, rows)

        for row in range(rows):
            for col in range(cols):
                front_x, front_y = front_card_position(start_x, start_y, row, col, rows)
                back_x, back_y = back_card_position(start_x, start_y, row, col, rows, cols)
                mirrored_front_x, mirrored_front_y = front_card_position(
                    start_x, start_y, row, cols - 1 - col, rows
                )

                assert back_x == mirrored_front_x
                assert back_y == mirrored_front_y
                assert front_y == back_y

    def test_grid_is_centered_on_a4_page(self):
        cols, rows = calculate_cards_per_page(*A4)
        start_x, start_y = calculate_grid_origin(A4[0], A4[1], cols, rows)

        assert start_x == pytest.approx((A4[0] - cols * CARD_WIDTH) / 2)
        assert start_y == pytest.approx((A4[1] - rows * CARD_HEIGHT) / 2)

    def test_back_position_accepts_printer_calibration_offsets(self):
        cols, rows = calculate_cards_per_page(*A4)
        start_x, start_y = calculate_grid_origin(A4[0], A4[1], cols, rows)
        base_x, base_y = back_card_position(start_x, start_y, 0, 0, rows, cols)
        adjusted_x, adjusted_y = back_card_position(
            start_x, start_y, 0, 0, rows, cols, x_offset=3, y_offset=-5
        )

        assert adjusted_x == base_x + 3
        assert adjusted_y == base_y - 5
