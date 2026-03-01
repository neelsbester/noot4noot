"""Spotify playlist importer - fetches tracks from a Spotify playlist."""

import csv
import re
import os
import time
from pathlib import Path
from typing import List, Optional

try:
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    from spotipy.exceptions import SpotifyException
    SPOTIPY_AVAILABLE = True
except ImportError:
    SPOTIPY_AVAILABLE = False


def extract_playlist_id(playlist_url: str) -> str:
    """
    Extract the playlist ID from a Spotify playlist URL.

    Supports formats:
    - https://open.spotify.com/playlist/0Dsp6i8lvmcTg5aiusjnFH
    - https://open.spotify.com/playlist/0Dsp6i8lvmcTg5aiusjnFH?si=...
    - spotify:playlist:0Dsp6i8lvmcTg5aiusjnFH
    - 0Dsp6i8lvmcTg5aiusjnFH (just the ID)
    """
    # If it's already just an ID (alphanumeric, 22 chars)
    if re.match(r'^[a-zA-Z0-9]{22}$', playlist_url):
        return playlist_url

    # Handle spotify URI format
    if playlist_url.startswith('spotify:playlist:'):
        return playlist_url.split(':')[-1]

    # Handle URL format
    pattern = r'spotify\.com/playlist/([a-zA-Z0-9]+)'
    match = re.search(pattern, playlist_url)
    if match:
        return match.group(1)

    raise ValueError(f"Could not extract playlist ID from: {playlist_url}")


def get_spotify_client(client_id: Optional[str] = None, client_secret: Optional[str] = None) -> 'spotipy.Spotify':
    """
    Create an authenticated Spotify client.

    Credentials can be passed directly or set via environment variables:
    - SPOTIPY_CLIENT_ID
    - SPOTIPY_CLIENT_SECRET
    """
    if not SPOTIPY_AVAILABLE:
        raise ImportError(
            "spotipy is not installed. Install it with: pip install spotipy"
        )

    # Use provided credentials or fall back to environment variables
    client_id = client_id or os.environ.get('SPOTIPY_CLIENT_ID')
    client_secret = client_secret or os.environ.get('SPOTIPY_CLIENT_SECRET')

    if not client_id or not client_secret:
        raise ValueError(
            "Spotify API credentials required.\n"
            "Set SPOTIPY_CLIENT_ID and SPOTIPY_CLIENT_SECRET environment variables,\n"
            "or pass client_id and client_secret parameters.\n\n"
            "Get your credentials at: https://developer.spotify.com/dashboard"
        )

    auth_manager = SpotifyClientCredentials(
        client_id=client_id,
        client_secret=client_secret
    )
    return spotipy.Spotify(auth_manager=auth_manager)


def _call_with_retry(fn, *args, max_retries: int = 5, **kwargs):
    """
    Call a Spotify API function with exponential backoff on rate limit errors.

    Honors the Retry-After header when present (HTTP 429). Falls back to
    exponential backoff for other transient errors.

    Args:
        fn: The callable to invoke
        *args: Positional arguments forwarded to fn
        max_retries: Maximum number of retry attempts
        **kwargs: Keyword arguments forwarded to fn

    Returns:
        The return value of fn(*args, **kwargs)

    Raises:
        SpotifyException: If the error is not recoverable or retries exhausted
    """
    backoff = 1.0
    for attempt in range(max_retries):
        try:
            return fn(*args, **kwargs)
        except SpotifyException as exc:
            if exc.http_status == 429:
                retry_after = float(exc.headers.get('Retry-After', backoff)) if exc.headers else backoff
                print(f"  Rate limited by Spotify. Waiting {retry_after:.0f}s before retry...")
                time.sleep(retry_after)
                backoff = min(backoff * 2, 60)
            else:
                raise
    # Final attempt without catching
    return fn(*args, **kwargs)


def fetch_playlist_tracks(playlist_url: str, client_id: Optional[str] = None,
                          client_secret: Optional[str] = None) -> List[dict]:
    """
    Fetch all tracks from a Spotify playlist.

    Args:
        playlist_url: Spotify playlist URL or ID
        client_id: Spotify API client ID (optional if env var set)
        client_secret: Spotify API client secret (optional if env var set)

    Returns:
        List of track dictionaries with title, artist, year, spotify_url
    """
    sp = get_spotify_client(client_id, client_secret)
    playlist_id = extract_playlist_id(playlist_url)

    tracks = []
    offset = 0
    limit = 100  # Max allowed by Spotify API

    print(f"Fetching tracks from playlist...")

    # Fetch total count first so we terminate by total, not by empty page.
    # An empty items list does NOT reliably indicate the end — Spotify may
    # return empty pages when tracks are unavailable in a region while more
    # tracks still exist at a later offset.
    results = _call_with_retry(
        sp.playlist_tracks,
        playlist_id,
        offset=offset,
        limit=limit,
        fields='items(track(id,name,artists,album(release_date),external_urls)),total'
    )
    total = results.get('total', 0)

    while offset < total:
        if offset > 0:
            results = _call_with_retry(
                sp.playlist_tracks,
                playlist_id,
                offset=offset,
                limit=limit,
                fields='items(track(id,name,artists,album(release_date),external_urls)),total'
            )

        items = results.get('items', [])

        for item in items:
            track = item.get('track')
            if not track:  # Skip if track is None (can happen with local files)
                continue

            # Extract track info
            title = track.get('name', 'Unknown')

            # Get all artists
            artists = track.get('artists', [])
            artist_names = [a.get('name', 'Unknown') for a in artists]
            artist = ', '.join(artist_names) if artist_names else 'Unknown'

            # Get year from album release date — guard against malformed dates
            album = track.get('album', {})
            release_date = album.get('release_date', '')
            try:
                year = int(release_date[:4]) if release_date and len(release_date) >= 4 else 0
            except ValueError:
                year = 0

            # Get Spotify URL
            external_urls = track.get('external_urls', {})
            spotify_url = external_urls.get('spotify', '')

            if spotify_url:  # Only add if we have a valid URL
                tracks.append({
                    'title': title,
                    'artist': artist,
                    'year': year,
                    'spotify_url': spotify_url
                })

        offset += limit
        print(f"  Fetched {min(offset, total)}/{total} tracks...")

    print(f"Successfully fetched {len(tracks)} tracks!")
    return tracks


def save_tracks_to_csv(tracks: List[dict], output_path: Path):
    """
    Save track list to a CSV file.

    Args:
        tracks: List of track dictionaries
        output_path: Path to save the CSV file
    """
    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['title', 'artist', 'year', 'spotify_url'])
        writer.writeheader()
        writer.writerows(tracks)

    print(f"Saved {len(tracks)} tracks to {output_path}")


def import_playlist(playlist_url: str, output_path: Path,
                    client_id: Optional[str] = None,
                    client_secret: Optional[str] = None) -> List[dict]:
    """
    Import a Spotify playlist and save it as a CSV file.

    Args:
        playlist_url: Spotify playlist URL or ID
        output_path: Path to save the CSV file
        client_id: Spotify API client ID (optional if env var set)
        client_secret: Spotify API client secret (optional if env var set)

    Returns:
        List of imported track dictionaries
    """
    tracks = fetch_playlist_tracks(playlist_url, client_id, client_secret)
    save_tracks_to_csv(tracks, output_path)
    return tracks
