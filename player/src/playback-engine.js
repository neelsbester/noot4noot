/**
 * PlaybackEngine - Base class for all playback implementations
 *
 * Strategy pattern: Different engines handle playback differently
 * - SDKPlayer: Spotify Web Playback SDK (Premium required)
 * - ExternalDevicePlayer: Spotify Connect devices (Premium required)
 */

/**
 * @typedef {Object} TrackInfo
 * @property {string} id - Spotify track ID
 * @property {string} uri - Spotify URI (spotify:track:xxx)
 * @property {string} name - Track name
 * @property {string[]} artists - Array of artist names
 * @property {string} artistString - Comma-separated artist names
 * @property {string} album - Album name
 * @property {string|null} albumArt - Album art URL (large)
 * @property {string|null} albumArtSmall - Album art URL (small)
 * @property {number|null} year - Release year
 * @property {number} durationMs - Duration in milliseconds
 * @property {string|null} previewUrl - 30-second preview URL
 */

/**
 * Base class for playback engines
 * @abstract
 */
export class PlaybackEngine {
  constructor() {
    if (new.target === PlaybackEngine) {
      throw new Error('PlaybackEngine is abstract and cannot be instantiated directly');
    }
    this._isPlaying = false;
    this._currentTrack = null;
    this._onTrackEnd = null;
    this._onError = null;
    this._onStateChange = null;
  }

  /**
   * Whether this engine requires Spotify authentication
   * @returns {boolean}
   */
  get requiresAuth() {
    return true;
  }

  /**
   * Engine type identifier
   * @returns {string}
   */
  get type() {
    throw new Error('Subclass must implement type getter');
  }

  /**
   * Current playback state
   * @returns {boolean}
   */
  get isPlaying() {
    return this._isPlaying;
  }

  /**
   * Currently loaded track info
   * @returns {TrackInfo|null}
   */
  get currentTrack() {
    return this._currentTrack;
  }

  /**
   * Set callback for when track ends
   * @param {Function} callback
   */
  set onTrackEnd(callback) {
    this._onTrackEnd = callback;
  }

  /**
   * Set callback for errors
   * @param {Function} callback
   */
  set onError(callback) {
    this._onError = callback;
  }

  /**
   * Set callback for state changes (play/pause)
   * @param {Function} callback - Receives {isPlaying: boolean}
   */
  set onStateChange(callback) {
    this._onStateChange = callback;
  }

  /**
   * Initialize the engine
   * @param {Object} options - Engine-specific options
   * @returns {Promise<void>}
   */
  async initialize(options = {}) {
    throw new Error('Subclass must implement initialize()');
  }

  /**
   * Play a track
   * @param {string} trackUri - Spotify track URI
   * @param {TrackInfo} [trackInfo] - Optional pre-fetched track info
   * @returns {Promise<TrackInfo>} Track info
   */
  async play(trackUri, trackInfo = null) {
    throw new Error('Subclass must implement play()');
  }

  /**
   * Pause playback
   * @returns {Promise<void>}
   */
  async pause() {
    throw new Error('Subclass must implement pause()');
  }

  /**
   * Resume playback
   * @returns {Promise<void>}
   */
  async resume() {
    throw new Error('Subclass must implement resume()');
  }

  /**
   * Toggle play/pause
   * @returns {Promise<boolean>} New playing state
   */
  async togglePlayback() {
    if (this._isPlaying) {
      await this.pause();
    } else {
      await this.resume();
    }
    return this._isPlaying;
  }

  /**
   * Set playback volume
   * @param {number} percent - Volume level (0-100)
   * @returns {Promise<void>}
   */
  async setVolume(percent) {
    throw new Error('Subclass must implement setVolume()');
  }

  /**
   * Clean up resources
   */
  destroy() {
    this._isPlaying = false;
    this._currentTrack = null;
  }

  /**
   * Emit state change event
   * @protected
   */
  _emitStateChange() {
    if (this._onStateChange) {
      this._onStateChange({ isPlaying: this._isPlaying });
    }
  }

  /**
   * Emit track end event
   * @protected
   */
  _emitTrackEnd() {
    if (this._onTrackEnd) {
      this._onTrackEnd();
    }
  }

  /**
   * Emit error event
   * @protected
   * @param {Error|string} error
   */
  _emitError(error) {
    if (this._onError) {
      this._onError(error instanceof Error ? error : new Error(error));
    }
  }
}
