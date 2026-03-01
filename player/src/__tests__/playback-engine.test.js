/**
 * Tests for PlaybackEngine base class
 *
 * - _extractYear() parsing from various Spotify release_date formats
 * - Abstract class instantiation guard
 * - Abstract method enforcement
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PlaybackEngine } from '../playback-engine.js';

/**
 * Concrete stub that satisfies the abstract guard so we can test
 * inherited helper methods like _extractYear().
 */
class StubEngine extends PlaybackEngine {
  get type() {
    return 'stub';
  }
}

describe('PlaybackEngine abstract guard', () => {
  it('throws when instantiated directly', () => {
    expect(() => new PlaybackEngine()).toThrow(
      'PlaybackEngine is abstract and cannot be instantiated directly'
    );
  });

  it('allows subclass instantiation', () => {
    const engine = new StubEngine();
    expect(engine.type).toBe('stub');
  });
});

describe('PlaybackEngine abstract methods', () => {
  let engine;

  beforeEach(() => {
    engine = new StubEngine();
  });

  it('initialize() throws', async () => {
    await expect(engine.initialize()).rejects.toThrow('Subclass must implement initialize()');
  });

  it('play() throws', async () => {
    await expect(engine.play('spotify:track:abc')).rejects.toThrow('Subclass must implement play()');
  });

  it('pause() throws', async () => {
    await expect(engine.pause()).rejects.toThrow('Subclass must implement pause()');
  });

  it('resume() throws', async () => {
    await expect(engine.resume()).rejects.toThrow('Subclass must implement resume()');
  });

  it('setVolume() throws', async () => {
    await expect(engine.setVolume(50)).rejects.toThrow('Subclass must implement setVolume()');
  });

  it('type getter throws on base class', () => {
    // Directly test the base class getter by calling it on a plain object
    const baseDescriptor = Object.getOwnPropertyDescriptor(PlaybackEngine.prototype, 'type');
    expect(() => baseDescriptor.get.call({})).toThrow('Subclass must implement type getter');
  });
});

describe('PlaybackEngine._extractYear', () => {
  let engine;

  beforeEach(() => {
    engine = new StubEngine();
  });

  it('extracts year from YYYY-MM-DD format', () => {
    expect(engine._extractYear('2020-05-15')).toBe(2020);
  });

  it('extracts year from YYYY-MM format', () => {
    expect(engine._extractYear('1999-12')).toBe(1999);
  });

  it('extracts year from YYYY format', () => {
    expect(engine._extractYear('1975')).toBe(1975);
  });

  it('returns null for null input', () => {
    expect(engine._extractYear(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(engine._extractYear(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(engine._extractYear('')).toBeNull();
  });

  it('returns null for non-numeric string', () => {
    expect(engine._extractYear('abcd-ef-gh')).toBeNull();
  });
});

describe('PlaybackEngine default state', () => {
  it('isPlaying defaults to false', () => {
    const engine = new StubEngine();
    expect(engine.isPlaying).toBe(false);
  });

  it('currentTrack defaults to null', () => {
    const engine = new StubEngine();
    expect(engine.currentTrack).toBeNull();
  });

  it('requiresAuth defaults to true', () => {
    const engine = new StubEngine();
    expect(engine.requiresAuth).toBe(true);
  });
});

describe('PlaybackEngine.destroy', () => {
  it('resets playing state and current track', () => {
    const engine = new StubEngine();
    engine._isPlaying = true;
    engine._currentTrack = { id: 'test' };

    engine.destroy();

    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTrack).toBeNull();
  });
});
