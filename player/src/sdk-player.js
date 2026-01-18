/**
 * SDKPlayer - Spotify Web Playback SDK for full track playback in browser
 *
 * Creates this browser as a Spotify Connect device.
 * Requires Spotify Premium.
 */

import { PlaybackEngine } from './playback-engine.js';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

export class SDKPlayer extends PlaybackEngine {
  constructor() {
    super();
    this._token = null;
    this._player = null;
    this._deviceId = null;
    this._ready = false;
    this._volume = 50;
    this._getTokenCallback = null;
  }

  get requiresAuth() {
    return true;
  }

  get type() {
    return 'sdk';
  }

  /**
   * Get the SDK device ID (for external use)
   */
  get deviceId() {
    return this._deviceId;
  }

  /**
   * Initialize the Spotify Web Playback SDK
   * @param {Object} options
   * @param {string} options.token - Spotify access token
   * @param {Function} [options.getToken] - Callback to get fresh token on expiry
   * @param {string} [options.name='Hitster Web Player'] - Device name
   * @param {number} [options.volume=50] - Initial volume (0-100)
   */
  async initialize(options = {}) {
    const { token, getToken, name = 'Hitster Web Player', volume = 50 } = options;

    if (!token) {
      throw new Error('Access token required for SDK player');
    }

    this._token = token;
    this._getTokenCallback = getToken || null;
    this._volume = volume;

    // Wait for SDK to load
    await this._waitForSDK();

    return new Promise((resolve, reject) => {
      this._player = new window.Spotify.Player({
        name,
        getOAuthToken: async (cb) => {
          // Try to get fresh token if callback provided
          if (this._getTokenCallback) {
            try {
              const freshToken = await this._getTokenCallback();
              if (freshToken) {
                this._token = freshToken;
              }
            } catch (error) {
              console.warn('Failed to refresh token:', error);
            }
          }
          cb(this._token);
        },
        volume: this._volume / 100
      });

      // Error handling
      this._player.addListener('initialization_error', ({ message }) => {
        console.error('SDK initialization error:', message);
        reject(new Error(`SDK initialization failed: ${message}`));
      });

      this._player.addListener('authentication_error', ({ message }) => {
        console.error('SDK authentication error:', message);
        this._emitError(new Error('Authentication failed. Please log in again.'));
      });

      this._player.addListener('account_error', ({ message }) => {
        console.error('SDK account error:', message);
        this._emitError(new Error('Spotify Premium required for in-browser playback.'));
      });

      this._player.addListener('playback_error', ({ message }) => {
        console.error('SDK playback error:', message);
        this._emitError(new Error(`Playback error: ${message}`));
      });

      // Ready event
      this._player.addListener('ready', ({ device_id }) => {
        console.log('SDK ready, device ID:', device_id);
        this._deviceId = device_id;
        this._ready = true;
        resolve();
      });

      // Not ready event
      this._player.addListener('not_ready', ({ device_id }) => {
        console.warn('SDK not ready, device ID:', device_id);
        this._ready = false;
      });

      // Player state changes
      this._player.addListener('player_state_changed', (state) => {
        if (!state) return;

        const wasPlaying = this._isPlaying;
        this._isPlaying = !state.paused;

        // Update current track info
        if (state.track_window?.current_track) {
          const track = state.track_window.current_track;
          this._currentTrack = {
            id: track.id,
            uri: track.uri,
            name: track.name,
            artists: track.artists.map(a => a.name),
            artistString: track.artists.map(a => a.name).join(', '),
            album: track.album.name,
            albumArt: track.album.images[0]?.url || null,
            albumArtSmall: track.album.images[2]?.url || track.album.images[0]?.url || null,
            year: null, // SDK doesn't provide release date
            durationMs: track.duration_ms,
            previewUrl: null
          };
        }

        // Emit state change
        if (wasPlaying !== this._isPlaying) {
          this._emitStateChange();
        }

        // Check if track ended
        if (state.paused && state.position === 0 && state.track_window?.previous_tracks?.length > 0) {
          this._emitTrackEnd();
        }
      });

      // Connect to Spotify
      this._player.connect().then((success) => {
        if (!success) {
          reject(new Error('Failed to connect to Spotify'));
        }
      });
    });
  }

  /**
   * Wait for Spotify SDK to be available
   * @private
   */
  _waitForSDK(timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (window.Spotify) {
        resolve();
        return;
      }

      const startTime = Date.now();

      // Set up the callback that Spotify SDK calls when ready
      window.onSpotifyWebPlaybackSDKReady = () => {
        resolve();
      };

      // Also poll in case the callback was missed
      const checkInterval = setInterval(() => {
        if (window.Spotify) {
          clearInterval(checkInterval);
          resolve();
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error('Spotify SDK failed to load. Please refresh the page.'));
        }
      }, 100);
    });
  }

  /**
   * Play a track
   * @param {string} trackUri - Spotify track URI
   * @param {Object} [trackInfo] - Optional track info (ignored, SDK provides its own)
   */
  async play(trackUri, trackInfo = null) {
    if (!this._ready || !this._deviceId) {
      throw new Error('SDK player not ready');
    }

    // Use Spotify Web API to start playback on our SDK device
    const response = await fetch(`${SPOTIFY_API_BASE}/me/player/play?device_id=${this._deviceId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this._token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uris: [trackUri]
      })
    });

    if (!response.ok && response.status !== 204) {
      if (response.status === 401) {
        throw new Error('Token expired. Please log in again.');
      }
      if (response.status === 403) {
        throw new Error('Spotify Premium required for playback.');
      }
      if (response.status === 404) {
        throw new Error('Player not found. Please refresh the page.');
      }
      const errorText = await response.text();
      throw new Error(`Playback failed: ${errorText}`);
    }

    this._isPlaying = true;

    // Fetch full track info (SDK doesn't provide year)
    const info = await this._fetchTrackInfo(trackUri.split(':')[2]);
    this._currentTrack = info;

    return info;
  }

  /**
   * Fetch track info from Spotify API
   * @private
   */
  async _fetchTrackInfo(trackId) {
    try {
      const response = await fetch(`${SPOTIFY_API_BASE}/tracks/${trackId}`, {
        headers: {
          'Authorization': `Bearer ${this._token}`
        }
      });

      if (response.ok) {
        const track = await response.json();
        return {
          id: track.id,
          uri: track.uri,
          name: track.name,
          artists: track.artists.map(a => a.name),
          artistString: track.artists.map(a => a.name).join(', '),
          album: track.album.name,
          albumArt: track.album.images[0]?.url || null,
          albumArtSmall: track.album.images[2]?.url || track.album.images[0]?.url || null,
          year: this._extractYear(track.album.release_date),
          durationMs: track.duration_ms,
          previewUrl: track.preview_url
        };
      }
    } catch (error) {
      console.warn('Failed to fetch track info:', error);
    }

    return this._currentTrack || {
      id: trackId,
      uri: `spotify:track:${trackId}`,
      name: 'Unknown Track',
      artists: ['Unknown Artist'],
      artistString: 'Unknown Artist',
      album: 'Unknown Album',
      albumArt: null,
      albumArtSmall: null,
      year: null,
      durationMs: 0,
      previewUrl: null
    };
  }

  /**
   * Extract year from release date
   * @private
   */
  _extractYear(releaseDate) {
    if (!releaseDate) return null;
    const year = parseInt(releaseDate.substring(0, 4), 10);
    return isNaN(year) ? null : year;
  }

  async pause() {
    if (this._player) {
      await this._player.pause();
    }
  }

  async resume() {
    if (this._player) {
      await this._player.resume();
    }
  }

  async setVolume(percent) {
    this._volume = Math.max(0, Math.min(100, percent));
    if (this._player) {
      await this._player.setVolume(this._volume / 100);
    }
  }

  destroy() {
    if (this._player) {
      this._player.disconnect();
      this._player = null;
    }
    this._deviceId = null;
    this._ready = false;
    super.destroy();
  }
}
