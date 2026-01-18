/**
 * QR Code Scanner Module
 * 
 * Uses html5-qrcode library for camera-based QR code scanning.
 * Uses jsQR for inverted QR codes (white on dark background) with native support.
 */

import { Html5Qrcode } from 'html5-qrcode';
import jsQR from 'jsqr';

// Set to true to enable debug logging to on-screen panel and console
const DEBUG_MODE = false;

/**
 * Add a debug entry to the on-screen debug panel
 * Set DEBUG_MODE = true at the top of this file to enable
 */
function debugLog(message, type = 'info') {
  if (!DEBUG_MODE) return;
  
  const debugLogEl = document.getElementById('debug-log');
  if (!debugLogEl) return;
  
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement('p');
  entry.className = `debug-entry ${type}`;
  entry.innerHTML = `<span class="timestamp">${timestamp}</span>${message}`;
  
  // Add at the top
  debugLogEl.insertBefore(entry, debugLogEl.firstChild);
  
  // Keep only last 20 entries
  while (debugLogEl.children.length > 20) {
    debugLogEl.removeChild(debugLogEl.lastChild);
  }
  
  console.log(`[Scanner ${type}]`, message);
}

// Set up debug panel (only when DEBUG_MODE is enabled)
if (DEBUG_MODE) {
  document.addEventListener('DOMContentLoaded', () => {
    // Show the debug panel
    const debugPanel = document.getElementById('debug-panel');
    if (debugPanel) {
      debugPanel.removeAttribute('hidden');
    }
    
    // Set up clear button
    const clearBtn = document.getElementById('clear-debug');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const debugLogEl = document.getElementById('debug-log');
        if (debugLogEl) {
          debugLogEl.innerHTML = '<p class="debug-entry info">Cleared. Waiting for scan...</p>';
        }
      });
    }
  });
}

export class QRScanner {
  /**
   * Create a new QR scanner instance
   * @param {string} elementId - ID of the container element
   * @param {Object} options - Scanner options
   * @param {Function} options.onScan - Callback when a valid Spotify track is scanned
   * @param {Function} options.onError - Callback for errors
   * @param {number} options.cooldownMs - Cooldown between scans (default: 3000ms)
   */
  constructor(elementId, options = {}) {
    this.elementId = elementId;
    this.onScan = options.onScan || (() => {});
    this.onError = options.onError || console.error;
    this.cooldownMs = options.cooldownMs || 3000;
    
    this.scanner = null;
    this.videoElement = null;
    this.canvas = null;
    this.canvasCtx = null;
    this.scanInterval = null;
    this.invertedScanInterval = null;
    this.isScanning = false;
    this.lastScannedCode = null;
    this.lastScanTime = 0;
    
    debugLog('Scanner initialized (jsQR + inverted mode)', 'info');
  }

  /**
   * Start the QR scanner with inverted frame support
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isScanning) {
      debugLog('Scanner already running', 'info');
      return;
    }

    debugLog('Starting scanner...', 'info');

    try {
      this.scanner = new Html5Qrcode(this.elementId);
      debugLog('Html5Qrcode instance created', 'info');
      
      // Scanner configuration
      const config = {
        fps: 10,
        qrbox: { width: 280, height: 280 },
        experimentalFeatures: {
          useBarCodeDetectorIfSupported: true
        }
      };

      debugLog('Starting camera...', 'info');
      
      let frameCount = 0;
      let invertedScanCount = 0;

      await this.scanner.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => {
          debugLog(`🎯 NORMAL scan: "${decodedText}"`, 'success');
          this.handleScan(decodedText);
        },
        (errorMessage) => {
          frameCount++;
          if (frameCount === 1) {
            debugLog('📷 Camera active, starting inverted scanning...', 'success');
            // Start inverted frame scanning after camera is active
            this.startInvertedScanning();
          }
          if (frameCount % 200 === 0) {
            debugLog(`Frames: ${frameCount}, Inverted scans: ${invertedScanCount}`, 'info');
          }
        }
      );

      this.isScanning = true;
      debugLog('✅ Scanner started! Scanning both normal and inverted.', 'success');
      
    } catch (error) {
      debugLog(`❌ Camera error: ${error.message}`, 'error');
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Start scanning inverted frames from the video using jsQR
   */
  startInvertedScanning() {
    // Get the video element created by html5-qrcode
    this.videoElement = document.querySelector(`#${this.elementId} video`);
    if (!this.videoElement) {
      debugLog('Could not find video element for inverted scanning', 'error');
      return;
    }

    // Create a canvas for frame processing
    this.canvas = document.createElement('canvas');
    this.canvasCtx = this.canvas.getContext('2d', { willReadFrequently: true });

    debugLog('jsQR inverted scanning enabled (attemptBoth mode)', 'success');

    // Scan frames periodically with jsQR (primary scanner)
    this.scanInterval = setInterval(() => {
      this.scanWithJsQR();
    }, 100); // Scan 10 times per second for better responsiveness

    // Also run manual inversion scan as fallback (less frequently)
    this.invertedScanInterval = setInterval(() => {
      this.scanInvertedFrame();
    }, 300); // 3 times per second
  }

  /**
   * Scan a frame using jsQR with inversionAttempts for better inverted QR support
   */
  scanWithJsQR() {
    if (!this.videoElement || !this.canvas || !this.isScanning) return;
    if (this.videoElement.readyState !== 4) return; // Video not ready

    try {
      const width = this.videoElement.videoWidth;
      const height = this.videoElement.videoHeight;
      
      if (width === 0 || height === 0) return;

      // Set canvas size
      this.canvas.width = width;
      this.canvas.height = height;

      // Draw video frame to canvas
      this.canvasCtx.drawImage(this.videoElement, 0, 0, width, height);

      // Get image data
      const imageData = this.canvasCtx.getImageData(0, 0, width, height);

      // Use jsQR with inversionAttempts to handle both normal and inverted QR codes
      const code = jsQR(imageData.data, width, height, {
        inversionAttempts: 'attemptBoth', // Try both normal and inverted
      });

      if (code && code.data) {
        debugLog(`🎯 jsQR scan: "${code.data}"`, 'success');
        this.handleScan(code.data);
      }
    } catch (error) {
      // Error scanning frame - don't log to avoid spam
    }
  }

  /**
   * Scan with manual color inversion for edge cases
   * (Used as fallback when jsQR's built-in inversion isn't enough)
   */
  scanInvertedFrame() {
    if (!this.videoElement || !this.canvas || !this.isScanning) return;
    if (this.videoElement.readyState !== 4) return;

    try {
      const width = this.videoElement.videoWidth;
      const height = this.videoElement.videoHeight;
      
      if (width === 0 || height === 0) return;

      this.canvas.width = width;
      this.canvas.height = height;
      this.canvasCtx.drawImage(this.videoElement, 0, 0, width, height);

      const imageData = this.canvasCtx.getImageData(0, 0, width, height);
      const data = imageData.data;
      
      // Invert colors
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];       // Red
        data[i + 1] = 255 - data[i + 1]; // Green
        data[i + 2] = 255 - data[i + 2]; // Blue
      }

      // Scan the inverted image
      const code = jsQR(data, width, height, {
        inversionAttempts: 'dontInvert', // Already inverted manually
      });

      if (code && code.data) {
        debugLog(`🎯 Manual invert scan: "${code.data}"`, 'success');
        this.handleScan(code.data);
      }
    } catch (error) {
      // No QR found
    }
  }

  /**
   * Stop the QR scanner
   * @returns {Promise<void>}
   */
  async stop() {
    // Stop jsQR scanning
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    // Stop manual inverted scanning
    if (this.invertedScanInterval) {
      clearInterval(this.invertedScanInterval);
      this.invertedScanInterval = null;
    }

    if (!this.isScanning || !this.scanner) {
      return;
    }

    try {
      await this.scanner.stop();
      this.isScanning = false;
      debugLog('Scanner stopped', 'info');
    } catch (error) {
      debugLog(`Error stopping: ${error.message}`, 'error');
    }
  }

  /**
   * Handle a successful QR scan
   * @param {string} decodedText - The decoded QR code content
   */
  handleScan(decodedText) {
    const now = Date.now();
    
    // Check cooldown
    if (now - this.lastScanTime < this.cooldownMs) {
      return; // Silent during cooldown
    }

    // Check if it's the same code (debounce)
    if (decodedText === this.lastScannedCode && now - this.lastScanTime < this.cooldownMs * 2) {
      return;
    }

    // Validate Spotify track URI
    const trackUri = this.extractSpotifyTrackUri(decodedText);
    
    if (!trackUri) {
      debugLog(`❌ Not Spotify: "${decodedText.substring(0, 40)}..."`, 'error');
      return;
    }

    // Update state
    this.lastScannedCode = decodedText;
    this.lastScanTime = now;

    // Visual feedback
    this.triggerScanAnimation();

    // Call the callback with the track URI
    debugLog(`🎵 Playing: ${trackUri}`, 'success');
    this.onScan(trackUri);
  }

  /**
   * Extract Spotify track URI from scanned content
   */
  extractSpotifyTrackUri(content) {
    if (!content) return null;
    
    const trimmed = content.trim();

    // Already a Spotify URI
    if (trimmed.startsWith('spotify:track:')) {
      const trackId = trimmed.split(':')[2];
      if (this.isValidTrackId(trackId)) {
        return trimmed;
      }
    }

    // Spotify URL
    const urlMatch = trimmed.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
    if (urlMatch && this.isValidTrackId(urlMatch[1])) {
      return `spotify:track:${urlMatch[1]}`;
    }

    return null;
  }

  /**
   * Validate a Spotify track ID
   */
  isValidTrackId(trackId) {
    return trackId && /^[a-zA-Z0-9]{15,25}$/.test(trackId);
  }

  /**
   * Trigger visual scan animation
   */
  triggerScanAnimation() {
    const element = document.getElementById(this.elementId);
    if (element) {
      element.classList.add('scanned');
      setTimeout(() => {
        element.classList.remove('scanned');
      }, 500);
    }
  }

  /**
   * Handle scanner errors
   */
  handleError(error) {
    let message = 'Scanner error';
    
    if (error.name === 'NotAllowedError') {
      message = 'Camera permission denied. Please allow camera access and reload.';
    } else if (error.name === 'NotFoundError') {
      message = 'No camera found on this device.';
    } else if (error.name === 'NotReadableError') {
      message = 'Camera is in use by another application.';
    } else if (error.message) {
      message = error.message;
    }

    console.error('Scanner error:', message, error);
    this.onError(message);
  }

  /**
   * Check if scanner is currently running
   */
  get running() {
    return this.isScanning;
  }

  /**
   * Reset the last scanned code
   */
  resetLastScan() {
    this.lastScannedCode = null;
    this.lastScanTime = 0;
  }
}
