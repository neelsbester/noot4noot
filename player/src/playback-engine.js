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

export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

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
   * Make an authenticated API request. Returns parsed JSON body or null for 204.
   * Subclasses must set this._token or override _getToken().
   * @protected
   * @param {string} endpoint - API endpoint path (e.g. '/me/player') or full URL
   * @param {Object} [options] - Fetch options
   * @returns {Promise<Object|null>}
   */
  async _apiRequest(endpoint, options = {}) {
    const token = await this._getToken();
    if (!token) throw new Error('No valid token available');

    const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 401) {
      throw new Error('Token expired');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error?.error?.message || `API error: ${response.status}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * Get the current access token. Override in subclasses for dynamic token refresh.
   * @protected
   * @returns {Promise<string|null>}
   */
  async _getToken() {
    return this._token ?? null;
  }

  /**
   * Fetch track info from Spotify API
   * @protected
   * @param {string} trackUri - Spotify track URI (spotify:track:xxx)
   * @returns {Promise<TrackInfo>}
   */
  async _fetchTrackInfo(trackUri) {
    const trackId = trackUri.replace('spotify:track:', '');
    const data = await this._apiRequest(`/tracks/${trackId}`);
    return {
      id: data.id,
      uri: data.uri,
      name: data.name,
      artists: data.artists.map(a => a.name),
      artistString: data.artists.map(a => a.name).join(', '),
      album: data.album.name,
      albumArt: data.album.images?.[0]?.url || null,
      albumArtSmall: data.album.images?.[2]?.url || data.album.images?.[0]?.url || null,
      year: this._extractYear(data.album.release_date),
      durationMs: data.duration_ms,
      previewUrl: data.preview_url ?? null,
    };
  }

  /**
   * Extract year from a Spotify release_date string (YYYY, YYYY-MM, or YYYY-MM-DD)
   * @protected
   * @param {string|null|undefined} releaseDate
   * @returns {number|null}
   */
  _extractYear(releaseDate) {
    if (!releaseDate) return null;
    const year = parseInt(releaseDate.substring(0, 4), 10);
    return isNaN(year) ? null : year;
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
