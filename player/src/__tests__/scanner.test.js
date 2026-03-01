/**
 * Tests for QRScanner.extractSpotifyTrackUri()
 *
 * The scanner class requires DOM and camera APIs for most methods, but
 * extractSpotifyTrackUri() is a pure function that we can test in isolation
 * by creating a minimal QRScanner instance.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub DOM globals so the scanner module can be imported
vi.stubGlobal('document', {
  getElementById: vi.fn(() => null),
  querySelector: vi.fn(() => null),
  createElement: vi.fn(() => ({
    className: '',
    appendChild: vi.fn(),
    getContext: vi.fn(),
  })),
  addEventListener: vi.fn(),
});

// The QRScanner class — we only need extractSpotifyTrackUri and isValidTrackId
const { QRScanner } = await import('../scanner.js');

describe('QRScanner.extractSpotifyTrackUri', () => {
  let scanner;

  beforeEach(() => {
    // Create a scanner instance without starting camera
    scanner = new QRScanner('test-element', {
      onScan: vi.fn(),
      onError: vi.fn(),
    });
  });

  // ── Valid spotify: URIs ───────────────────────────────────────────────

  it('accepts a valid spotify:track: URI', () => {
    const uri = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
    expect(scanner.extractSpotifyTrackUri(uri)).toBe(uri);
  });

  it('handles URI with leading/trailing whitespace', () => {
    const uri = '  spotify:track:4cOdK2wGLETKBW3PvgPWqT  ';
    expect(scanner.extractSpotifyTrackUri(uri)).toBe('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
  });

  // ── Valid open.spotify.com URLs ───────────────────────────────────────

  it('extracts URI from open.spotify.com URL', () => {
    const url = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
    expect(scanner.extractSpotifyTrackUri(url)).toBe('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
  });

  it('extracts URI from URL with query parameters', () => {
    const url = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123';
    expect(scanner.extractSpotifyTrackUri(url)).toBe('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
  });

  // ── Invalid inputs ────────────────────────────────────────────────────

  it('returns null for empty string', () => {
    expect(scanner.extractSpotifyTrackUri('')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(scanner.extractSpotifyTrackUri(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(scanner.extractSpotifyTrackUri(undefined)).toBeNull();
  });

  it('returns null for random text', () => {
    expect(scanner.extractSpotifyTrackUri('hello world')).toBeNull();
  });

  it('returns null for non-spotify URL', () => {
    expect(scanner.extractSpotifyTrackUri('https://example.com/track/abc')).toBeNull();
  });

  // ── Non-track URIs ────────────────────────────────────────────────────

  it('rejects spotify:album: URI', () => {
    expect(scanner.extractSpotifyTrackUri('spotify:album:4cOdK2wGLETKBW3PvgPWqT')).toBeNull();
  });

  it('rejects spotify:playlist: URI', () => {
    expect(scanner.extractSpotifyTrackUri('spotify:playlist:37i9dQZF1DXcBWIGoY')).toBeNull();
  });

  it('rejects spotify:artist: URI', () => {
    expect(scanner.extractSpotifyTrackUri('spotify:artist:4cOdK2wGLETKBW3PvgPWqT')).toBeNull();
  });

  // ── Edge cases: track ID length validation ────────────────────────────

  it('rejects track ID shorter than 15 chars', () => {
    expect(scanner.extractSpotifyTrackUri('spotify:track:short')).toBeNull();
  });

  it('rejects track ID longer than 25 chars', () => {
    expect(scanner.extractSpotifyTrackUri('spotify:track:' + 'a'.repeat(30))).toBeNull();
  });
});
