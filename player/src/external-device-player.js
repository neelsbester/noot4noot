/**
 * ExternalDevicePlayer - Spotify Connect external device playback
 *
 * Controls playback on external Spotify Connect devices (phones, speakers, etc.).
 * Requires Spotify Premium.
 */

import { PlaybackEngine } from './playback-engine.js';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

export class ExternalDevicePlayer extends PlaybackEngine {
  constructor() {
    super();
    this._token = null;
    this._deviceId = null;
    this._deviceName = null;
  }

  get requiresAuth() {
    return true;
  }

  get type() {
    return 'external';
  }

  /**
   * Get the selected device ID
   */
  get deviceId() {
    return this._deviceId;
  }

  /**
   * Get the selected device name
   */
  get deviceName() {
    return this._deviceName;
  }

  /**
   * Initialize the external device player
   * @param {Object} options
   * @param {string} options.token - Spotify access token
   */
  async initialize(options = {}) {
    const { token } = options;

    if (!token) {
      throw new Error('Access token required for external device player');
    }

    this._token = token;
    console.log('ExternalDevicePlayer initialized');
  }

  /**
   * Make an authenticated API request
   * @private
   */
  async _apiRequest(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this._token}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (response.status === 401) {
      throw new Error('Token expired. Please log in again.');
    }

    if (response.status === 403) {
      throw new Error('Premium required for playback control.');
    }

    if (response.status === 404) {
      throw new Error('No active device found. Open Spotify on a device first.');
    }

    return response;
  }

  /**
   * Get available playback devices
   * @returns {Promise<Array>} List of available devices
   */
  async getDevices() {
    const response = await this._apiRequest('/me/player/devices');

    if (!response.ok) {
      throw new Error('Failed to get devices');
    }

    const data = await response.json();
    return data.devices || [];
  }

  /**
   * Set the target device for playback
   * @param {string} deviceId - Spotify device ID
   * @param {string} [deviceName] - Device name for display
   */
  setDevice(deviceId, deviceName = null) {
    this._deviceId = deviceId;
    this._deviceName = deviceName;
  }

  /**
   * Transfer playback to selected device
   * @param {string} deviceId - Device ID to transfer to
   * @param {boolean} play - Whether to start playing immediately
   */
  async transferPlayback(deviceId, play = false) {
    const response = await this._apiRequest('/me/player', {
      method: 'PUT',
      body: JSON.stringify({
        device_ids: [deviceId],
        play
      })
    });

    if (!response.ok && response.status !== 204) {
      throw new Error('Failed to transfer playback');
    }

    this._deviceId = deviceId;
  }

  /**
   * Play a track
   * @param {string} trackUri - Spotify track URI
   * @param {Object} [trackInfo] - Optional track info (not used, we fetch fresh)
   */
  async play(trackUri, trackInfo = null) {
    let endpoint = '/me/player/play';
    if (this._deviceId) {
      endpoint += `?device_id=${this._deviceId}`;
    }

    const response = await this._apiRequest(endpoint, {
      method: 'PUT',
      body: JSON.stringify({
        uris: [trackUri]
      })
    });

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      console.error('Play error:', response.status, errorText);

      if (response.status === 404) {
        throw new Error('No active device. Open Spotify on your device first.');
      }
      throw new Error('Failed to start playback');
    }

    this._isPlaying = true;

    // Fetch track info
    const trackId = trackUri.split(':')[2];
    const info = await this._fetchTrackInfo(trackId);
    this._currentTrack = info;

    return info;
  }

  /**
   * Fetch track info from Spotify API
   * @private
   */
  async _fetchTrackInfo(trackId) {
    const response = await this._apiRequest(`/tracks/${trackId}`);

    if (!response.ok) {
      throw new Error('Failed to get track info');
    }

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
    let endpoint = '/me/player/pause';
    if (this._deviceId) {
      endpoint += `?device_id=${this._deviceId}`;
    }

    const response = await this._apiRequest(endpoint, { method: 'PUT' });

    if (!response.ok && response.status !== 204) {
      throw new Error('Failed to pause playback');
    }

    this._isPlaying = false;
    this._emitStateChange();
  }

  async resume() {
    let endpoint = '/me/player/play';
    if (this._deviceId) {
      endpoint += `?device_id=${this._deviceId}`;
    }

    const response = await this._apiRequest(endpoint, { method: 'PUT' });

    if (!response.ok && response.status !== 204) {
      throw new Error('Failed to resume playback');
    }

    this._isPlaying = true;
    this._emitStateChange();
  }

  async setVolume(percent) {
    const volume = Math.max(0, Math.min(100, Math.round(percent)));

    let endpoint = `/me/player/volume?volume_percent=${volume}`;
    if (this._deviceId) {
      endpoint += `&device_id=${this._deviceId}`;
    }

    const response = await this._apiRequest(endpoint, { method: 'PUT' });

    if (!response.ok && response.status !== 204) {
      throw new Error('Failed to set volume');
    }
  }

  /**
   * Get current playback state
   * @returns {Promise<Object|null>} Current playback state or null if nothing playing
   */
  async getPlaybackState() {
    const response = await this._apiRequest('/me/player');

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      throw new Error('Failed to get playback state');
    }

    return response.json();
  }

  /**
   * Get the current user's profile
   * @returns {Promise<Object>} User profile
   */
  async getUserProfile() {
    const response = await this._apiRequest('/me');

    if (!response.ok) {
      throw new Error('Failed to get user profile');
    }

    return response.json();
  }

  destroy() {
    this._deviceId = null;
    this._deviceName = null;
    super.destroy();
  }
}
