"""CLI entry point for the Noot4Noot card toolkit."""

import argparse
import csv
import random
import sys
from pathlib import Path

from .csv_parser import load_songs
from .pdf_generator import generate_cards_pdf


def cmd_generate(args):
    """Generate PDF cards from a CSV file."""
    input_path = Path(args.input)
    output_path = Path(args.output)
    
    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    try:
        # Load songs from CSV
        print(f"Loading songs from {input_path}...")
        songs = load_songs(input_path)
        print(f"Found {len(songs)} songs")
        
        # Generate PDF
        print(f"Generating cards...")
        generate_cards_pdf(
            songs,
            output_path,
            back_x_offset_mm=args.back_x_offset_mm,
            back_y_offset_mm=args.back_y_offset_mm,
        )
        
        print(f"\nSuccess! Cards saved to: {output_path}")
        print("\nPrinting tips:")
        print("  1. Print double-sided (flip on short edge)")
        print("  2. Use cardstock for durability")
        print("  3. Cut along the crop marks")
        
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_import(args):
    """Import a Spotify playlist to CSV."""
    try:
        from .spotify_importer import import_playlist
    except ImportError as e:
        print(f"Error: {e}", file=sys.stderr)
        print("\nInstall spotipy with: pip install spotipy", file=sys.stderr)
        sys.exit(1)
    
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    try:
        print(f"Importing playlist: {args.playlist}")
        tracks = import_playlist(
            args.playlist,
            output_path,
            client_id=args.client_id,
            client_secret=args.client_secret
        )
        
        print(f"\nSuccess! Imported {len(tracks)} songs to: {output_path}")
        print(f"\nNext step: Generate cards with:")
        print(f"  python -m src.main generate -i {output_path}")
        
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_shuffle(args):
    """Shuffle a song CSV while preserving its header row."""
    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        if not input_path.exists():
            raise FileNotFoundError(f"CSV file not found: {input_path}")

        with open(input_path, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames is None:
                raise ValueError("CSV file is empty or has no header row")
            rows = list(reader)

        if not rows:
            raise ValueError("CSV file contains no songs")

        rng = random.Random(args.seed)
        rng.shuffle(rows)

        with open(output_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=reader.fieldnames)
            writer.writeheader()
            writer.writerows(rows)

        print(f"Shuffled {len(rows)} songs into: {output_path}")
        if args.seed is not None:
            print(f"Seed: {args.seed}")

    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    """Main entry point for the CLI."""
    parser = argparse.ArgumentParser(
        description="Noot4Noot - create, shuffle, and print QR code cards from Spotify playlists",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Commands')
    
    # Generate command
    gen_parser = subparsers.add_parser(
        'generate',
        help='Generate PDF cards from a CSV file',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python -m src.main generate -i songs.csv -o output/cards.pdf
        """
    )
    gen_parser.add_argument(
        "-i", "--input",
        type=str,
        required=True,
        help="Path to CSV file containing song data"
    )
    gen_parser.add_argument(
        "-o", "--output",
        type=str,
        default="output/cards.pdf",
        help="Output path for the generated PDF (default: output/cards.pdf)"
    )
    gen_parser.add_argument(
        "--back-x-offset-mm",
        type=float,
        default=0.0,
        help=(
            "Horizontal calibration offset applied only to card backs, in mm. "
            "Positive values move backs right on the PDF."
        )
    )
    gen_parser.add_argument(
        "--back-y-offset-mm",
        type=float,
        default=0.0,
        help=(
            "Vertical calibration offset applied only to card backs, in mm. "
            "Positive values move backs up on the PDF."
        )
    )
    gen_parser.set_defaults(func=cmd_generate)
    
    # Import command
    import_parser = subparsers.add_parser(
        'import',
        help='Import a Spotify playlist to CSV',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python -m src.main import -p https://open.spotify.com/playlist/xxxxx -o playlist.csv

Note: Requires Spotify API credentials. Get them at https://developer.spotify.com/dashboard
Set environment variables SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET,
or pass them with --client-id and --client-secret.
        """
    )
    import_parser.add_argument(
        "-p", "--playlist",
        type=str,
        required=True,
        help="Spotify playlist URL or ID"
    )
    import_parser.add_argument(
        "-o", "--output",
        type=str,
        default="playlist.csv",
        help="Output path for the CSV file (default: playlist.csv)"
    )
    import_parser.add_argument(
        "--client-id",
        type=str,
        help="Spotify API client ID (or set SPOTIPY_CLIENT_ID env var)"
    )
    import_parser.add_argument(
        "--client-secret",
        type=str,
        help=(
            "Spotify API client secret (or set SPOTIPY_CLIENT_SECRET env var). "
            "Prefer the environment variable over passing this flag directly to "
            "avoid the secret appearing in shell history or process listings."
        )
    )
    import_parser.set_defaults(func=cmd_import)

    # Shuffle command
    shuffle_parser = subparsers.add_parser(
        'shuffle',
        help='Shuffle a song CSV while preserving the header',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python -m src shuffle -i playlist.csv -o playlist_shuffled.csv --seed 42
        """
    )
    shuffle_parser.add_argument(
        "-i", "--input",
        type=str,
        required=True,
        help="Path to CSV file containing song data"
    )
    shuffle_parser.add_argument(
        "-o", "--output",
        type=str,
        required=True,
        help="Output path for the shuffled CSV"
    )
    shuffle_parser.add_argument(
        "--seed",
        type=int,
        help="Optional random seed for reproducible shuffles"
    )
    shuffle_parser.set_defaults(func=cmd_shuffle)
    
    # Parse arguments
    args = parser.parse_args()
    
    if args.command is None:
        parser.print_help()
        sys.exit(1)
    
    # Run the appropriate command
    args.func(args)


if __name__ == "__main__":
    main()
