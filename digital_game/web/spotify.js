const TOKEN_KEY = 'noot4noot_spotify_token';
const EXPIRY_KEY = 'noot4noot_spotify_token_expiry';
const REFRESH_KEY = 'noot4noot_spotify_refresh_token';
const VERIFIER_KEY = 'noot4noot_game_code_verifier';
const STATE_KEY = 'noot4noot_game_auth_state';
const ROOM_KEY = 'noot4noot_game_auth_room';
const SEAT_KEY = 'noot4noot_game_auth_seat';
const MODE_KEY = 'noot4noot_game_auth_mode';
const DEVICE_KEY = 'noot4noot_game_spotify_device';

const SCOPES = [
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-currently-playing',
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

let clientId = '';

export function spotifyRedirectUri() {
  const port = window.location.port ? `:${window.location.port}` : '';
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `http://127.0.0.1${port}/callback`;
  }
  return `${window.location.origin}/callback`;
}

export async function configureSpotify() {
  const response = await fetch('/api/config');
  const config = await response.json();
  clientId = config.spotifyClientId || '';
  return config;
}

function randomString(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return [...values].map(value => alphabet[value % alphabet.length]).join('');
}

async function codeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export async function beginSpotifyLogin(room) {
  if (!clientId) await configureSpotify();
  if (!clientId) throw new Error('Spotify is not configured for this environment.');
  if (!window.crypto?.subtle) throw new Error('Spotify login must be opened from 127.0.0.1 or HTTPS');

  const verifier = randomString(64);
  const state = randomString(20);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(ROOM_KEY, room);
  sessionStorage.setItem(SEAT_KEY, new URLSearchParams(window.location.search).get('seat') || '');
  sessionStorage.setItem(MODE_KEY, new URLSearchParams(window.location.search).get('mode') || '');

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', spotifyRedirectUri());
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', await codeChallenge(verifier));
  window.location.assign(authUrl.toString());
}

export async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return null;
  if (error) {
    const room = sessionStorage.getItem(ROOM_KEY);
    if (room) window.history.replaceState({}, document.title, `/host?room=${encodeURIComponent(room)}`);
    clearPendingLogin();
    throw new Error(`Spotify login failed: ${error}`);
  }
  if (!clientId) await configureSpotify();

  const state = params.get('state');
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const room = sessionStorage.getItem(ROOM_KEY);
  const seat = sessionStorage.getItem(SEAT_KEY) || '';
  const mode = sessionStorage.getItem(MODE_KEY) || '';
  if (!state || state !== expectedState || !verifier || !room) {
    if (room) {
      restoreHostUrl(room, seat, mode);
      clearPendingLogin();
    }
    throw new Error('Spotify login state expired. Please connect again.');
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: spotifyRedirectUri(),
      code_verifier: verifier,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    restoreHostUrl(room, seat, mode);
    clearPendingLogin();
    throw new Error(data.error_description || data.error || 'Spotify token exchange failed');
  }

  localStorage.setItem(TOKEN_KEY, data.access_token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
  if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
  clearPendingLogin();
  restoreHostUrl(room, seat, mode);
  return data.access_token;
}

async function refreshToken() {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh || !clientId) return null;
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
  });
  if (!response.ok) {
    clearSpotifySession();
    return null;
  }
  const data = await response.json();
  localStorage.setItem(TOKEN_KEY, data.access_token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
  if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
  return data.access_token;
}

export async function getSpotifyToken() {
  if (!clientId) await configureSpotify();
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) || 0);
  if (!token) return null;
  if (Date.now() > expiry - 300_000) return refreshToken();
  return token;
}

async function spotifyRequest(path, options = {}) {
  let token = await getSpotifyToken();
  if (!token) throw new Error('Connect Spotify first');
  let response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (response.status === 401) {
    token = await refreshToken();
    if (!token) throw new Error('Spotify session expired');
    response = await fetch(`https://api.spotify.com/v1${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
    });
  }
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const suffix = retryAfter ? ` Try again in ${retryAfter} seconds.` : ' Wait briefly before trying again.';
      throw new Error(`Spotify rate limit reached.${suffix}`);
    }
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Spotify error (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

export async function getSpotifyDevices() {
  const data = await spotifyRequest('/me/player/devices');
  return data?.devices || [];
}

export async function playSpotifyTrack(uri, deviceId) {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await spotifyRequest(`/me/player/play${query}`, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
}

export async function pauseSpotifyPlayback(deviceId) {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await spotifyRequest(`/me/player/pause${query}`, { method: 'PUT' });
}

export function saveSpotifyDevice(deviceId) {
  localStorage.setItem(DEVICE_KEY, deviceId);
}

export function loadSpotifyDevice() {
  return localStorage.getItem(DEVICE_KEY) || '';
}

export function clearSpotifySession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(DEVICE_KEY);
}

function clearPendingLogin() {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(ROOM_KEY);
  sessionStorage.removeItem(SEAT_KEY);
  sessionStorage.removeItem(MODE_KEY);
}

function restoreHostUrl(room, seat = '', mode = '') {
  const seatQuery = seat ? `&seat=${encodeURIComponent(seat)}` : '';
  const modeQuery = mode ? `&mode=${encodeURIComponent(mode)}` : '';
  window.history.replaceState({}, document.title, `/host?room=${encodeURIComponent(room)}${seatQuery}${modeQuery}`);
}
