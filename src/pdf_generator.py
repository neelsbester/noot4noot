"""PDF generator for printable double-sided cards with premium concentric circles design."""

from io import BytesIO
from pathlib import Path
from typing import List
import math
import random

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import black, white, HexColor, Color
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth

from .csv_parser import Song
from .qr_generator import generate_spotify_qr


# ---------------------------------------------------------------------------
# Card dimensions (square cards)
#
# 60mm fits a 3 x 4 grid on A4 while leaving enough edge room for crop marks
# on home printers and enough tolerance for professional print trimming.
# ---------------------------------------------------------------------------
CARD_SIZE_MM = 60
CARD_WIDTH = CARD_SIZE_MM * mm
CARD_HEIGHT = CARD_SIZE_MM * mm

# Page margins
MARGIN = 10 * mm

# ---------------------------------------------------------------------------
# Typography constants
# ---------------------------------------------------------------------------
YEAR_FONT_SIZE = 32
TITLE_FONT_SIZE = 8
ARTIST_FONT_SIZE = 7
YEAR_FONT = "Helvetica-Bold"
TITLE_FONT = "Helvetica-Bold"
ARTIST_FONT = "Helvetica"

# ---------------------------------------------------------------------------
# Layout constants
# ---------------------------------------------------------------------------
STARBURST_LINE_COUNT = 48          # Radiating lines on card backs
STARBURST_INNER_RADIUS = 45       # px from center where starburst starts
CONTENT_CIRCLE_RADIUS = 55        # px — white content circle on card back
INNER_BORDER_PADDING = 8          # px inset for inner border rect
CORNER_ROSETTE_RADIUS = 6         # px
CORNER_ROSETTE_OFFSET = 18        # px from card corner

# ---------------------------------------------------------------------------
# Text width budget for the content circle (in points)
# Title and artist strings are truncated to fit inside the white circle.
# The content circle is 55pt radius → usable chord at typical y-offset ≈ 90pt.
# ---------------------------------------------------------------------------
TITLE_MAX_WIDTH = 88   # points
ARTIST_MAX_WIDTH = 88  # points

# ---------------------------------------------------------------------------
# Circle design constants
# ---------------------------------------------------------------------------
CIRCLE_LAYER_INNER_SPACING = 8     # pt between rings in inner layer
CIRCLE_LAYER_MID_SPACING = 7      # pt between rings in middle layer
CIRCLE_LAYER_OUTER_SPACING = 6    # pt between rings in outer layer
CIRCLE_LAYER_INNER_LW = 0.8       # line width for inner layer
CIRCLE_LAYER_MID_LW = 1.0         # line width for middle layer
CIRCLE_LAYER_OUTER_LW = 1.2       # line width for outer layer

# ---------------------------------------------------------------------------
# Decade-based color themes — colors evoke each era's aesthetic
# ---------------------------------------------------------------------------
DECADE_THEMES = {
    2020: {
        "name": "2020s",
        "primary": HexColor("#6366f1"),       # Indigo (modern tech/social media)
        "light_accent": HexColor("#818cf8"),
    },
    2010: {
        "name": "2010s",
        "primary": HexColor("#ec4899"),       # Pink (EDM/pop era, Instagram)
        "light_accent": HexColor("#f472b6"),
    },
    2000: {
        "name": "2000s",
        "primary": HexColor("#10b981"),       # Emerald green (Y2K, iPod era)
        "light_accent": HexColor("#34d399"),
    },
    1990: {
        "name": "1990s",
        "primary": HexColor("#14b8a6"),       # Teal (grunge, alternative)
        "light_accent": HexColor("#2dd4bf"),
    },
    1980: {
        "name": "1980s",
        "primary": HexColor("#f43f5e"),       # Hot pink/neon (synthwave, MTV)
        "light_accent": HexColor("#fb7185"),
    },
    1970: {
        "name": "1970s",
        "primary": HexColor("#f97316"),       # Orange (disco, funk)
        "light_accent": HexColor("#fb923c"),
    },
    1960: {
        "name": "1960s",
        "primary": HexColor("#a855f7"),       # Purple (psychedelic, flower power)
        "light_accent": HexColor("#c084fc"),
    },
    1950: {
        "name": "1950s",
        "primary": HexColor("#ef4444"),       # Classic red (rock & roll, diners)
        "light_accent": HexColor("#f87171"),
    },
    0: {
        "name": "pre-1950s",
        "primary": HexColor("#78716c"),       # Warm gray (vintage, classic)
        "light_accent": HexColor("#a8a29e"),
    },
}


def get_decade_theme(year: int) -> dict:
    """Get the color theme for a song based on its decade."""
    decade = max((year // 10) * 10, 1950) if year >= 1950 else 0
    return DECADE_THEMES.get(decade, DECADE_THEMES[0])


# Vibrant CMYK-inspired colors for the concentric circles design
CIRCLE_COLORS = [
    HexColor("#00e5ff"),  # Cyan
    HexColor("#ff00ff"),  # Magenta
    HexColor("#ffea00"),  # Yellow
    HexColor("#ff1493"),  # Deep pink
    HexColor("#00ff7f"),  # Spring green
]

# Card backgrounds
LIGHT_BG = HexColor("#f8f8f8")
CARD_BORDER_LIGHT = HexColor("#e0e0e0")


def _truncate_to_width(text: str, font_name: str, font_size: float, max_width: float) -> str:
    """
    Truncate text to fit within max_width points using actual rendered glyph widths.

    Measures with reportlab's stringWidth() for accuracy across unicode characters.

    Args:
        text: The string to truncate
        font_name: ReportLab font name (e.g., "Helvetica-Bold")
        font_size: Font size in points
        max_width: Maximum allowed rendered width in points

    Returns:
        Original string if it fits, otherwise truncated string ending in "..."
    """
    if stringWidth(text, font_name, font_size) <= max_width:
        return text

    ellipsis = "..."
    ellipsis_width = stringWidth(ellipsis, font_name, font_size)
    budget = max_width - ellipsis_width

    # Binary-search for the longest prefix that fits within budget
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if stringWidth(text[:mid], font_name, font_size) <= budget:
            lo = mid
        else:
            hi = mid - 1

    return text[:lo] + ellipsis


def calculate_cards_per_page(page_width: float, page_height: float) -> tuple:
    """Calculate how many cards fit on a page."""
    usable_width = page_width - (2 * MARGIN)
    usable_height = page_height - (2 * MARGIN)

    cols = int(usable_width // CARD_WIDTH)
    rows = int(usable_height // CARD_HEIGHT)

    return cols, rows


def draw_crop_marks(c: canvas.Canvas, x: float, y: float, length: float = 5 * mm):
    """Draw crop marks at card corners for cutting guide."""
    c.setStrokeColor(HexColor("#9ca3af"))
    c.setLineWidth(0.3)

    # Top-left
    c.line(x - length, y + CARD_HEIGHT, x - 2, y + CARD_HEIGHT)
    c.line(x, y + CARD_HEIGHT + 2, x, y + CARD_HEIGHT + length)

    # Top-right
    c.line(x + CARD_WIDTH + 2, y + CARD_HEIGHT, x + CARD_WIDTH + length, y + CARD_HEIGHT)
    c.line(x + CARD_WIDTH, y + CARD_HEIGHT + 2, x + CARD_WIDTH, y + CARD_HEIGHT + length)

    # Bottom-left
    c.line(x - length, y, x - 2, y)
    c.line(x, y - 2, x, y - length)

    # Bottom-right
    c.line(x + CARD_WIDTH + 2, y, x + CARD_WIDTH + length, y)
    c.line(x + CARD_WIDTH, y - 2, x + CARD_WIDTH, y - length)


def draw_corner_rosette(c: canvas.Canvas, cx: float, cy: float, radius: float, color: Color):
    """Draw a decorative rosette/flower pattern at the given center point."""
    c.setStrokeColor(color)
    c.setLineWidth(0.8)

    # Outer circle
    c.circle(cx, cy, radius, stroke=1, fill=0)

    # Inner decorative pattern — small circles around center
    inner_radius = radius * 0.4
    num_petals = 6
    for i in range(num_petals):
        angle = (i * 360 / num_petals) * math.pi / 180
        petal_x = cx + inner_radius * math.cos(angle)
        petal_y = cy + inner_radius * math.sin(angle)
        c.circle(petal_x, petal_y, radius * 0.2, stroke=1, fill=0)

    # Center dot
    c.circle(cx, cy, radius * 0.15, stroke=1, fill=0)


def draw_starburst_lines(c: canvas.Canvas, cx: float, cy: float,
                         inner_radius: float, outer_radius: float,
                         color: Color, num_lines: int = STARBURST_LINE_COUNT):
    """Draw radiating starburst lines from center."""
    c.setStrokeColor(color)
    c.setLineWidth(0.6)

    for i in range(num_lines):
        angle = (i * 360 / num_lines) * math.pi / 180

        x1 = cx + inner_radius * math.cos(angle)
        y1 = cy + inner_radius * math.sin(angle)

        x2 = cx + outer_radius * math.cos(angle)
        y2 = cy + outer_radius * math.sin(angle)

        c.line(x1, y1, x2, y2)


def draw_broken_arc(c: canvas.Canvas, cx: float, cy: float, radius: float,
                    start_angle: float, extent: float, color: Color, line_width: float = 1.0):
    """Draw a single arc segment."""
    c.setStrokeColor(color)
    c.setLineWidth(line_width)

    x1 = cx - radius
    y1 = cy - radius
    x2 = cx + radius
    y2 = cy + radius

    c.arc(x1, y1, x2, y2, start_angle, extent)


def draw_concentric_broken_circles(c: canvas.Canvas, cx: float, cy: float,
                                   min_radius: float, max_radius: float,
                                   colors: list, seed: int = None):
    """
    Draw concentric broken/segmented circles in vibrant colors.

    Creates the signature Noot4Noot card design with three distinct layers.
    Uses a local RNG instance seeded per-card so global random state is
    never mutated.
    """
    rng = random.Random(seed)

    total_range = max_radius - min_radius
    layer_size = total_range / 3

    layers = [
        {"start": min_radius, "end": min_radius + layer_size,
         "spacing": CIRCLE_LAYER_INNER_SPACING, "line_width": CIRCLE_LAYER_INNER_LW},
        {"start": min_radius + layer_size, "end": min_radius + 2 * layer_size,
         "spacing": CIRCLE_LAYER_MID_SPACING, "line_width": CIRCLE_LAYER_MID_LW},
        {"start": min_radius + 2 * layer_size, "end": max_radius,
         "spacing": CIRCLE_LAYER_OUTER_SPACING, "line_width": CIRCLE_LAYER_OUTER_LW},
    ]

    for layer_idx, layer in enumerate(layers):
        layer_start = layer["start"]
        layer_end = layer["end"]
        ring_spacing = layer["spacing"]
        base_line_width = layer["line_width"]

        num_rings = int((layer_end - layer_start) / ring_spacing)

        for ring_idx in range(num_rings):
            radius = layer_start + (ring_idx * ring_spacing) + 3

            num_segments = rng.randint(3, 6)
            total_arc_degrees = rng.randint(240, 320)
            gap_degrees = (360 - total_arc_degrees) / num_segments
            current_angle = rng.randint(0, 360)

            for seg_idx in range(num_segments):
                arc_extent = total_arc_degrees / num_segments + rng.randint(-20, 20)
                arc_extent = max(20, min(120, arc_extent))

                color = colors[(layer_idx + ring_idx + seg_idx) % len(colors)]
                line_width = base_line_width + (ring_idx % 2) * 0.15

                draw_broken_arc(c, cx, cy, radius, current_angle, arc_extent, color, line_width)

                current_angle += arc_extent + gap_degrees + rng.randint(-10, 10)


def draw_inner_border(c: canvas.Canvas, x: float, y: float, color: Color,
                      padding: float = INNER_BORDER_PADDING):
    """Draw the inner rectangular border with rounded corners."""
    c.setStrokeColor(color)
    c.setLineWidth(1.2)

    border_x = x + padding
    border_y = y + padding
    border_width = CARD_WIDTH - 2 * padding
    border_height = CARD_HEIGHT - 2 * padding

    c.rect(border_x, border_y, border_width, border_height, stroke=1, fill=0)


def draw_qr_front(c: canvas.Canvas, x: float, y: float, song: Song, card_num: int, theme: dict):
    """Draw the front of a card (QR code side) with concentric broken circles design on black background."""
    cx = x + CARD_WIDTH / 2
    cy = y + CARD_HEIGHT / 2

    # Solid black background
    c.setFillColor(black)
    c.setStrokeColor(black)
    c.rect(x, y, CARD_WIDTH, CARD_HEIGHT, stroke=1, fill=1)

    qr_size = int(CARD_WIDTH * 0.50)

    min_radius = qr_size / 2 + 8
    max_radius = min(CARD_WIDTH, CARD_HEIGHT) / 2 - 5

    draw_concentric_broken_circles(c, cx, cy, min_radius, max_radius, CIRCLE_COLORS, seed=card_num)

    qr_img = generate_spotify_qr(song.spotify_uri, size=qr_size, inverted=True)

    img_buffer = BytesIO()
    qr_img.save(img_buffer, format='PNG')
    img_buffer.seek(0)
    qr_reader = ImageReader(img_buffer)

    qr_x = cx - qr_size / 2
    qr_y = cy - qr_size / 2
    c.drawImage(qr_reader, qr_x, qr_y, width=qr_size, height=qr_size, mask='auto')


def draw_song_back(c: canvas.Canvas, x: float, y: float, song: Song, card_num: int, theme: dict):
    """Draw the back of a card (song details side) with starburst design — ink-saving outline version."""
    primary_color = theme["primary"]
    light_accent = theme["light_accent"]

    cx = x + CARD_WIDTH / 2
    cy = y + CARD_HEIGHT / 2

    outer_radius = min(CARD_WIDTH, CARD_HEIGHT) / 2 - 15
    draw_starburst_lines(c, cx, cy, STARBURST_INNER_RADIUS, outer_radius, light_accent,
                         num_lines=STARBURST_LINE_COUNT)

    # Inner border
    c.setStrokeColor(light_accent)
    c.setLineWidth(1.2)
    c.rect(
        x + INNER_BORDER_PADDING,
        y + INNER_BORDER_PADDING,
        CARD_WIDTH - 2 * INNER_BORDER_PADDING,
        CARD_HEIGHT - 2 * INNER_BORDER_PADDING,
        stroke=1, fill=0
    )

    # Corner rosettes
    draw_corner_rosette(c, x + CORNER_ROSETTE_OFFSET, y + CARD_HEIGHT - CORNER_ROSETTE_OFFSET,
                        CORNER_ROSETTE_RADIUS, light_accent)
    draw_corner_rosette(c, x + CARD_WIDTH - CORNER_ROSETTE_OFFSET, y + CARD_HEIGHT - CORNER_ROSETTE_OFFSET,
                        CORNER_ROSETTE_RADIUS, light_accent)
    draw_corner_rosette(c, x + CORNER_ROSETTE_OFFSET, y + CORNER_ROSETTE_OFFSET,
                        CORNER_ROSETTE_RADIUS, light_accent)
    draw_corner_rosette(c, x + CARD_WIDTH - CORNER_ROSETTE_OFFSET, y + CORNER_ROSETTE_OFFSET,
                        CORNER_ROSETTE_RADIUS, light_accent)

    # White content circle
    c.setFillColor(white)
    c.circle(cx, cy, CONTENT_CIRCLE_RADIUS, stroke=0, fill=1)

    c.setStrokeColor(primary_color)
    c.setLineWidth(2)
    c.circle(cx, cy, CONTENT_CIRCLE_RADIUS, stroke=1, fill=0)

    # Year — large and prominent
    c.setFillColor(primary_color)
    c.setFont(YEAR_FONT, YEAR_FONT_SIZE)
    year_y = cy + 8
    c.drawCentredString(cx, year_y, str(song.year))

    # Song title — below year, truncated to fit the circle width
    c.setFont(TITLE_FONT, TITLE_FONT_SIZE)
    title = _truncate_to_width(song.title, TITLE_FONT, TITLE_FONT_SIZE, TITLE_MAX_WIDTH)
    c.drawCentredString(cx, year_y - 22, title)

    # Artist — below title, truncated to fit
    c.setFont(ARTIST_FONT, ARTIST_FONT_SIZE)
    c.setFillColor(HexColor("#666666"))
    artist = _truncate_to_width(song.artist, ARTIST_FONT, ARTIST_FONT_SIZE, ARTIST_MAX_WIDTH)
    c.drawCentredString(cx, year_y - 34, artist)

    # Outer card border
    c.setStrokeColor(primary_color)
    c.setLineWidth(1.5)
    c.rect(x, y, CARD_WIDTH, CARD_HEIGHT, stroke=1, fill=0)


def generate_cards_pdf(songs: List[Song], output_path: Path,
                       back_x_offset_mm: float = 0.0,
                       back_y_offset_mm: float = 0.0):
    """
    Generate a PDF with printable double-sided cards.

    The PDF alternates between front pages (QR codes) and back pages (song details).
    Cards on back pages are mirrored horizontally so they align when printed double-sided.

    Args:
        songs: List of Song objects to generate cards for
        output_path: Path where the PDF will be saved
        back_x_offset_mm: Calibration offset applied only to backs; positive moves right
        back_y_offset_mm: Calibration offset applied only to backs; positive moves up
    """
    page_width, page_height = A4
    cols, rows = calculate_cards_per_page(page_width, page_height)
    cards_per_page = cols * rows

    c = canvas.Canvas(str(output_path), pagesize=A4)
    back_x_offset = back_x_offset_mm * mm
    back_y_offset = back_y_offset_mm * mm

    start_x, start_y = calculate_grid_origin(page_width, page_height, cols, rows)

    total_songs = len(songs)

    for batch_start in range(0, total_songs, cards_per_page):
        batch = songs[batch_start:batch_start + cards_per_page]

        # === FRONT PAGE (QR codes) ===
        for idx, song in enumerate(batch):
            row = idx // cols
            col = idx % cols

            x, y = front_card_position(start_x, start_y, row, col, rows)

            card_num = batch_start + idx + 1
            print(f"  Generating card {card_num}/{total_songs}...")
            theme = get_decade_theme(song.year)

            draw_crop_marks(c, x, y)
            draw_qr_front(c, x, y, song, card_num, theme)

        c.showPage()

        # === BACK PAGE (Song details) ===
        # Mirror horizontally for double-sided printing alignment
        for idx, song in enumerate(batch):
            row = idx // cols
            col = idx % cols

            x, y = back_card_position(
                start_x,
                start_y,
                row,
                col,
                rows,
                cols,
                x_offset=back_x_offset,
                y_offset=back_y_offset,
            )

            card_num = batch_start + idx + 1
            theme = get_decade_theme(song.year)

            draw_crop_marks(c, x, y)
            draw_song_back(c, x, y, song, card_num, theme)

        c.showPage()

    c.save()
    print(f"\nGenerated {total_songs} cards in {output_path}")
    print(f"Layout: {cols} columns x {rows} rows = {cards_per_page} cards per page")
    print(f"Card size: {CARD_SIZE_MM}mm x {CARD_SIZE_MM}mm")
    print(f"Total pages: {((total_songs - 1) // cards_per_page + 1) * 2} (front + back)")
    if back_x_offset_mm or back_y_offset_mm:
        print(f"Back-page calibration offset: x={back_x_offset_mm} mm, y={back_y_offset_mm} mm")


def calculate_grid_origin(page_width: float, page_height: float, cols: int, rows: int) -> tuple:
    """Return the centered card-grid origin for a page."""
    total_cards_width = cols * CARD_WIDTH
    total_cards_height = rows * CARD_HEIGHT
    return (
        (page_width - total_cards_width) / 2,
        (page_height - total_cards_height) / 2,
    )


def front_card_position(start_x: float, start_y: float, row: int, col: int, rows: int) -> tuple:
    """Return the front-page card position for a row/column in the print grid."""
    x = start_x + (col * CARD_WIDTH)
    y = start_y + ((rows - 1 - row) * CARD_HEIGHT)
    return x, y


def back_card_position(start_x: float, start_y: float, row: int, col: int,
                       rows: int, cols: int, x_offset: float = 0.0,
                       y_offset: float = 0.0) -> tuple:
    """
    Return the matching back-page card position for short-edge duplex printing.

    Portrait A4 printed duplex with "flip on short edge" keeps the vertical
    order and mirrors columns horizontally, so each card back lands behind its
    QR front after the sheet is flipped.
    """
    mirrored_col = cols - 1 - col
    x, y = front_card_position(start_x, start_y, row, mirrored_col, rows)
    return x + x_offset, y + y_offset
