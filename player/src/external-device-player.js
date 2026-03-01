/**
 * ExternalDevicePlayer - Spotify Connect external device playback
 *
 * Controls playback on external Spotify Connect devices (phones, speakers, etc.).
 * Requires Spotify Premium.
 */

import { PlaybackEngine } from './playback-engine.js';

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
   * Get available playback devices
   * @returns {Promise<Array>} List of available devices
   */
  async getDevices() {
    const data = await this._apiRequest('/me/player/devices');
    return data?.devices || [];
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
    await this._apiRequest('/me/player', {
      method: 'PUT',
      body: JSON.stringify({
        device_ids: [deviceId],
        play,
      }),
    });

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

    await this._apiRequest(endpoint, {
      method: 'PUT',
      body: JSON.stringify({ uris: [trackUri] }),
    });

    this._isPlaying = true;

    // Fetch track info
    const info = await this._fetchTrackInfo(trackUri);
    this._currentTrack = info;

    return info;
  }

  async pause() {
    let endpoint = '/me/player/pause';
    if (this._deviceId) {
      endpoint += `?device_id=${this._deviceId}`;
    }

    await this._apiRequest(endpoint, { method: 'PUT' });

    this._isPlaying = false;
    this._emitStateChange();
  }

  async resume() {
    let endpoint = '/me/player/play';
    if (this._deviceId) {
      endpoint += `?device_id=${this._deviceId}`;
    }

    await this._apiRequest(endpoint, { method: 'PUT' });

    this._isPlaying = true;
    this._emitStateChange();
  }

  async setVolume(percent) {
    const volume = Math.max(0, Math.min(100, Math.round(percent)));

    let endpoint = `/me/player/volume?volume_percent=${volume}`;
    if (this._deviceId) {
      endpoint += `&device_id=${this._deviceId}`;
    }

    await this._apiRequest(endpoint, { method: 'PUT' });
  }

  /**
   * Get current playback state
   * @returns {Promise<Object|null>} Current playback state or null if nothing playing
   */
  async getPlaybackState() {
    return this._apiRequest('/me/player');
  }

  /**
   * Get the current user's profile
   * @returns {Promise<Object>} User profile
   */
  async getUserProfile() {
    return this._apiRequest('/me');
  }

  destroy() {
    this._deviceId = null;
    this._deviceName = null;
    super.destroy();
  }
}
