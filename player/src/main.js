/**
 * Hitster Player - Main Application
 *
 * Supports two playback modes:
 * - SDK: Full tracks via Spotify Web Playback SDK (in-browser)
 * - External: Full tracks via Spotify Connect devices
 */

import { login, handleCallback, getStoredToken, clearToken } from './auth.js';
import { QRScanner } from './scanner.js';
import { PlayerFactory } from './player-factory.js';
import {
  showToast,
  showScreen,
  escapeHtml,
  createDeviceItem,
  updateNowPlaying,
  updatePlayButton,
  updateRevealButton,
  revealSongInfo,
  updatePlayerHeader,
  hideScannerShowButton,
  showScannerHideButton
} from './ui.js';

// Storage keys
const DEVICE_KEY = 'hitster_selected_device';

// Application state
let player = null;
let scanner = null;
let currentMode = null;
let selectedDevice = null;
let isYearRevealed = false;

// M2: Playback in-progress guard
let isPlaybackInProgress = false;

// M3: AbortControllers for event listener management
let loginController = null;
let setupController = null;
let playerController = null;

/**
 * Save selected device to localStorage
 */
function saveDevice(device) {
  if (device) {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({
      id: device.id,
      name: device.name,
      type: device.type
    }));
  }
}

/**
 * Get saved device from localStorage
 */
function getSavedDevice() {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

/**
 * Clear saved device from localStorage
 */
function clearSavedDevice() {
  localStorage.removeItem(DEVICE_KEY);
}

/**
 * Initialize the application
 */
async function init() {
  console.log('Hitster Player initializing...');

  // Check for OAuth callback
  try {
    const callbackResult = await handleCallback();

    if (callbackResult?.error) {
      console.error('Callback error:', callbackResult.error);
      showToast('Login failed: ' + callbackResult.error, 'error');
      showScreen('login-screen');
      setupLoginHandlers();
      return;
    }

    // If we just got a token from callback, go to device selection
    if (callbackResult?.accessToken) {
      console.log('Got token from callback');
      await initializeWithToken(callbackResult.accessToken);
      return;
    }
  } catch (err) {
    console.error('Callback handling error:', err);
    showToast('Authentication error: ' + err.message, 'error');
  }

  // M14: getStoredToken() is now async — await it
  const token = await getStoredToken();

  if (token) {
    console.log('Found existing token');
    await initializeWithToken(token);
  } else {
    console.log('No token found, showing login screen');
    showScreen('login-screen');
    setupLoginHandlers();
  }
}

/**
 * Set up login screen event handlers
 */
function setupLoginHandlers() {
  // M3: Abort previous controller, create new one
  loginController?.abort();
  loginController = new AbortController();

  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
      await login();
    }, { signal: loginController.signal });
  }
}

/**
 * Initialize with a valid token
 * @param {string} token - Spotify access token
 */
async function initializeWithToken(token) {
  try {
    // Verify token works
    const response = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error('Token expired');
    }

    const user = await response.json();
    console.log('Logged in as:', user.display_name);
    showToast(`Welcome, ${user.display_name}!`, 'success');

    // Show device selection
    await showDeviceSelection(token);

  } catch (error) {
    console.error('Failed to initialize:', error);

    if (error.message.includes('expired') || error.message.includes('401')) {
      clearToken();
      clearSavedDevice();
      showToast('Session expired. Please log in again.', 'warning');
      showScreen('login-screen');
      setupLoginHandlers();
    } else {
      showToast(error.message, 'error');
    }
  }
}

/**
 * Show device selection screen
 * @param {string} token - Spotify access token
 */
async function showDeviceSelection(token) {
  showScreen('setup-screen');
  setupDeviceHandlers(token);
  await refreshDevices(token);
}

/**
 * Set up device selection screen handlers
 * @param {string} token - Spotify access token
 */
function setupDeviceHandlers(token) {
  // M3: Abort previous controller, create new one
  setupController?.abort();
  setupController = new AbortController();

  const refreshBtn = document.getElementById('refresh-devices-btn');
  const startBtn = document.getElementById('start-scanning-btn');
  const devicesList = document.getElementById('devices-list');

  if (refreshBtn) {
    // M4: Async handler with try/catch
    refreshBtn.addEventListener('click', async () => {
      try { await refreshDevices(token); } catch (e) { showToast(e.message, 'error'); }
    }, { signal: setupController.signal });
  }

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      try { await startPlayback(token); } catch (e) { showToast(e.message, 'error'); }
    }, { signal: setupController.signal });
  }

  if (devicesList) {
    devicesList.addEventListener('click', (e) => {
      const deviceItem = e.target.closest('.device-item');
      if (deviceItem) {
        selectDevice(deviceItem.dataset.deviceId, token);
      }
    }, { signal: setupController.signal });
  }

  // M10: Logout button handler
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      clearToken();
      showScreen('login-screen');
      setupLoginHandlers();
      showToast('Logged out', 'info');
    }, { signal: setupController.signal });
  }
}

/**
 * Refresh the list of available Spotify devices
 * @param {string} token - Spotify access token
 */
async function refreshDevices(token) {
  // M13: Null guards for devicesList and startBtn
  const devicesList = document.getElementById('devices-list');
  const startBtn = document.getElementById('start-scanning-btn');

  if (!devicesList) return;

  try {
    devicesList.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 2rem;">Loading devices...</p>';

    const response = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error('Failed to get devices');
    }

    const data = await response.json();
    const devices = data.devices || [];

    // Add "This Browser" as SDK option at the top
    const sdkDevice = {
      id: 'SDK_BROWSER',
      name: 'This Browser',
      type: 'Computer',
      is_active: false,
      is_sdk: true
    };

    const allDevices = [sdkDevice, ...devices];

    // Render devices
    devicesList.innerHTML = allDevices.map(device =>
      createDeviceItemWithSdk(device, device.id === selectedDevice?.id)
    ).join('');

    if (devices.length === 0) {
      devicesList.innerHTML += `
        <div style="text-align: center; padding: 1rem; color: var(--text-muted);">
          <p style="font-size: 0.85rem;">No external devices found</p>
          <p style="font-size: 0.8rem; margin-top: 0.25rem;">Open Spotify on a device to see it here</p>
        </div>
      `;
    }

    // Check for saved device
    const savedDevice = getSavedDevice();
    if (savedDevice && !selectedDevice) {
      const stillAvailable = allDevices.find(d => d.id === savedDevice.id);
      if (stillAvailable) {
        selectDevice(savedDevice.id, token, allDevices);
      }
    }

    // Auto-select active device if none selected
    if (!selectedDevice) {
      const activeDevice = devices.find(d => d.is_active);
      if (activeDevice) {
        selectDevice(activeDevice.id, token, allDevices);
      }
    } else if (startBtn) {
      startBtn.disabled = false;
    }

  } catch (error) {
    console.error('Failed to get devices:', error);
    devicesList.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: var(--error);">
        <p>Failed to load devices</p>
        <p style="font-size: 0.85rem; margin-top: 0.5rem;">${error.message}</p>
      </div>
    `;
    if (startBtn) startBtn.disabled = true;
  }
}

/**
 * Create device item HTML with SDK support
 */
function createDeviceItemWithSdk(device, isSelected = false) {
  if (device.is_sdk) {
    const selectedClass = isSelected ? 'selected' : '';
    // M6: Escape device.id to prevent XSS
    return `
      <div class="device-item ${selectedClass}" data-device-id="${escapeHtml(device.id)}">
        <div class="device-icon" style="background: rgba(29, 185, 84, 0.15); color: var(--spotify-green);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <div class="device-info">
          <div class="device-item-name">${device.name}</div>
          <div class="device-item-type">Play full tracks in this browser</div>
        </div>
      </div>
    `;
  }

  return createDeviceItem(device, isSelected);
}

/**
 * Select a device for playback
 */
async function selectDevice(deviceId, token, devices = null) {
  const startBtn = document.getElementById('start-scanning-btn');

  if (!devices) {
    const response = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    devices = [
      { id: 'SDK_BROWSER', name: 'This Browser', type: 'Computer', is_sdk: true },
      ...(data.devices || [])
    ];
  }

  const device = devices.find(d => d.id === deviceId);
  if (!device) return;

  selectedDevice = device;

  // Save external devices for session persistence
  if (!device.is_sdk) {
    saveDevice(device);
  }

  // Update UI
  document.querySelectorAll('.device-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.deviceId === deviceId);
  });

  if (startBtn) startBtn.disabled = false;
  showToast(`Selected: ${device.name}`, 'info', 2000);
}

/**
 * Start playback with selected device
 */
async function startPlayback(token) {
  if (!selectedDevice) {
    showToast('Please select a playback option', 'warning');
    return;
  }

  try {
    if (selectedDevice.is_sdk) {
      currentMode = 'sdk';
      await initializeSDKPlayer(token);
    } else {
      currentMode = 'external';
      await initializeExternalPlayer(token);
    }
  } catch (error) {
    console.error('Failed to start playback:', error);
    showToast(error.message, 'error');
  }
}

/**
 * Initialize SDK player for in-browser playback
 */
async function initializeSDKPlayer(token) {
  console.log('Initializing SDK player');

  player = PlayerFactory.create('sdk');

  // M9: Loading state during SDK init
  showToast('Connecting to Spotify...', 'info');

  try {
    await player.initialize({
      token,
      name: 'Hitster Web Player',
      volume: 50,
      // M14: getStoredToken() is now async
      getToken: async () => await getStoredToken()
    });

    player.onTrackEnd = () => {
      showToast('Track ended', 'info', 2000);
    };

    player.onError = (error) => {
      console.error('SDK player error:', error);
      if (error.message.includes('Premium')) {
        showToast('Spotify Premium required for in-browser playback', 'error', 5000);
        return;
      }
      showToast(error.message, 'error');
    };

    player.onStateChange = ({ isPlaying }) => {
      updatePlayButton(isPlaying);
    };

    showScreen('player-screen');
    updatePlayerHeader('sdk');
    setupPlayerHandlers();
    await startScanner();

    showToast('Playing in browser', 'success', 3000);

  } catch (error) {
    console.error('Failed to initialize SDK player:', error);

    if (error.message.includes('Premium') || error.message.includes('account')) {
      showToast('Premium required for in-browser playback. Select an external device.', 'warning', 5000);
      player.destroy();
      player = null;
      selectedDevice = null;
      await showDeviceSelection(token);
    } else {
      throw error;
    }
  }
}

/**
 * Initialize external device player
 */
async function initializeExternalPlayer(token) {
  console.log('Initializing external device player for:', selectedDevice.name);

  player = PlayerFactory.create('external');
  await player.initialize({ token });
  player.setDevice(selectedDevice.id, selectedDevice.name);

  player.onError = (error) => {
    console.error('External player error:', error);
    showToast(error.message, 'error');
  };

  showScreen('player-screen');
  updatePlayerHeader('external', selectedDevice.name);
  setupPlayerHandlers();
  await startScanner();

  showToast(`Playing on ${selectedDevice.name}`, 'success', 3000);
}

/**
 * Start the QR scanner
 */
async function startScanner() {
  try {
    scanner = new QRScanner('scanner', {
      onScan: handleScan,
      onError: (message) => showToast(message, 'error'),
      cooldownMs: 3000
    });

    await scanner.start();
    showToast('Scanner ready!', 'success', 2000);

  } catch (error) {
    console.error('Failed to start scanner:', error);

    // M8: Camera permission denied recovery
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      const scannerContainer = document.querySelector('.scanner-container');
      if (scannerContainer) {
        scannerContainer.innerHTML = `
          <div class="camera-denied">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 2 20 20"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><path d="M9.59 9.59 21 21"/><path d="m2 2 8 8"/><path d="M14 14.5V20a2 2 0 0 1-2 2"/><path d="M20 5a2 2 0 0 0-2-2h-3.38a2 2 0 0 1-1.41-.59l-.83-.82A2 2 0 0 0 11 1H8a2 2 0 0 0-2 2v3"/><path d="M3 10V5a2 2 0 0 1 2-2"/><circle cx="13" cy="11" r="3"/></svg>
            <p style="margin: 1rem 0 0.5rem; font-weight: 600;">Camera Access Required</p>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem;">Allow camera access in your browser settings to scan QR cards.</p>
            <button class="btn-primary" id="retry-camera-btn">Try Again</button>
          </div>
        `;
        document.getElementById('retry-camera-btn')?.addEventListener('click', () => startScanner(), { signal: playerController?.signal });
      }
    } else {
      showToast('Failed to start camera: ' + error.message, 'error');
    }
  }
}

/**
 * Set up player screen handlers
 */
function setupPlayerHandlers() {
  // M3: Abort previous controller, create new one
  playerController?.abort();
  playerController = new AbortController();

  const pauseBtn = document.getElementById('pause-btn');
  const revealBtn = document.getElementById('reveal-btn');
  const changeDeviceBtn = document.getElementById('change-device-btn');
  const scanAnotherBtn = document.getElementById('scan-another-btn');

  if (pauseBtn) {
    pauseBtn.addEventListener('click', togglePlayback, { signal: playerController.signal });
  }

  if (revealBtn) {
    revealBtn.addEventListener('click', handleReveal, { signal: playerController.signal });
  }

  if (changeDeviceBtn) {
    changeDeviceBtn.addEventListener('click', handleChangeDevice, { signal: playerController.signal });
  }

  if (scanAnotherBtn) {
    scanAnotherBtn.addEventListener('click', handleScanAnother, { signal: playerController.signal });
  }
}

/**
 * Handle "Scan Another Code" button click
 */
function handleScanAnother() {
  showScannerHideButton();
  showToast('Ready to scan!', 'info', 1500);
}

/**
 * Handle change device button
 */
async function handleChangeDevice() {
  if (scanner) {
    await scanner.stop();
    scanner = null;
  }

  if (player) {
    player.destroy();
    player = null;
  }

  clearSavedDevice();
  selectedDevice = null;
  currentMode = null;

  // M14: getStoredToken() is now async
  const token = await getStoredToken();
  if (token) {
    await showDeviceSelection(token);
  } else {
    showScreen('login-screen');
    setupLoginHandlers();
  }
}

/**
 * Handle a successful QR scan
 */
async function handleScan(spotifyUri) {
  // M5: Null guard for player
  if (!player) { showToast('Player not ready yet', 'warning'); return; }

  // M2: Playback in-progress guard
  if (isPlaybackInProgress) return;

  console.log('Playing:', spotifyUri);
  isYearRevealed = false;

  isPlaybackInProgress = true;
  try {
    updateNowPlaying(null);

    const track = await player.play(spotifyUri);

    updateNowPlaying(track, false);
    updatePlayButton(true);
    updateRevealButton(true, false);

    // Hide scanner and show "Scan Another Code" button
    hideScannerShowButton();

    // M11: Combined success toast with track info; removed intermediate "Loading track..." toast
    showToast(`Now playing: ${track.name}`, 'success', 2000);

    // M12: Show reveal hint
    const revealHint = document.getElementById('reveal-hint');
    if (revealHint) revealHint.hidden = false;

  } catch (error) {
    console.error('Playback error:', error);
    showToast(error.message, 'error');

    if (error.message.includes('device') || error.message.includes('No active')) {
      showToast('Device unavailable - check Spotify is open', 'warning', 5000);
    }
  } finally {
    isPlaybackInProgress = false;
  }
}

/**
 * Toggle play/pause
 */
async function togglePlayback() {
  if (!player) return;

  try {
    const isPlaying = await player.togglePlayback();
    updatePlayButton(isPlaying);
  } catch (error) {
    console.error('Toggle playback error:', error);
    showToast(error.message, 'error');
  }
}

/**
 * Reveal song info
 */
function handleReveal() {
  isYearRevealed = true;
  revealSongInfo();
  updateRevealButton(true, true);

  // M12: Hide reveal hint after reveal
  const revealHint = document.getElementById('reveal-hint');
  if (revealHint) revealHint.hidden = true;
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// M1: Guard debug object to DEV only
if (import.meta.env.DEV) {
  window.hitsterDebug = {
    getPlayer: () => player,
    getScanner: () => scanner,
    getSelectedDevice: () => selectedDevice,
    getCurrentMode: () => currentMode,
    clearSavedDevice,
    clearToken,
    login
  };
}
