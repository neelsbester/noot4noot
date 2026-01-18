/**
 * PlayerFactory - Creates playback engines based on mode
 *
 * Strategy pattern factory for different playback implementations:
 * - 'sdk': Spotify Web Playback SDK (Premium required, plays in browser)
 * - 'external': Spotify Connect external devices (Premium required)
 */

import { SDKPlayer } from './sdk-player.js';
import { ExternalDevicePlayer } from './external-device-player.js';

/**
 * Valid playback modes
 * @typedef {'sdk' | 'external'} PlaybackMode
 */

/**
 * Factory for creating playback engines
 */
export class PlayerFactory {
  /**
   * Create a playback engine instance
   * @param {PlaybackMode} mode - The playback mode
   * @returns {import('./playback-engine.js').PlaybackEngine}
   */
  static create(mode) {
    switch (mode) {
      case 'sdk':
        return new SDKPlayer();

      case 'external':
        return new ExternalDevicePlayer();

      default:
        throw new Error(`Unknown playback mode: ${mode}`);
    }
  }

  /**
   * Get human-readable description of a mode
   * @param {PlaybackMode} mode
   * @returns {string}
   */
  static getModeDescription(mode) {
    switch (mode) {
      case 'sdk':
        return 'Full tracks in this browser';
      case 'external':
        return 'Full tracks on external device';
      default:
        return 'Unknown mode';
    }
  }

  /**
   * Get all available modes
   * @returns {PlaybackMode[]}
   */
  static getModes() {
    return ['sdk', 'external'];
  }
}

// Re-export player classes for direct use
export { SDKPlayer } from './sdk-player.js';
export { ExternalDevicePlayer } from './external-device-player.js';
export { PlaybackEngine } from './playback-engine.js';
