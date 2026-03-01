"""QR code generator for Spotify URIs."""

import qrcode
from qrcode.image.pil import PilImage
from PIL import Image


def generate_qr_code(data: str, size: int = 200, inverted: bool = False) -> Image.Image:
    """
    Generate a QR code image for the given data.

    Args:
        data: The data to encode in the QR code (e.g., spotify:track:xxx)
        size: The desired size of the QR code in pixels
        inverted: If True, generate white QR on transparent background

    Returns:
        PIL Image object containing the QR code
    """
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)

    if inverted:
        # White QR code on transparent background
        img = qr.make_image(fill_color="white", back_color="transparent").convert("RGBA")
    else:
        img = qr.make_image(fill_color="black", back_color="white")

    # Resize to desired size
    img = img.resize((size, size), Image.Resampling.LANCZOS)

    return img


def generate_spotify_qr(spotify_uri: str, size: int = 200, inverted: bool = False) -> Image.Image:
    """
    Generate a QR code for a Spotify URI.

    When scanned on a mobile device, this will open directly in the Spotify app.

    Args:
        spotify_uri: Spotify URI (e.g., spotify:track:4cOdK2wGLETKBW3PvgPWqT)
        size: The desired size of the QR code in pixels
        inverted: If True, generate white QR on transparent background

    Returns:
        PIL Image object containing the QR code
    """
    return generate_qr_code(spotify_uri, size, inverted)
