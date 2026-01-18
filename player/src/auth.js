/**
 * Spotify OAuth Authentication Module
 * 
 * Handles the OAuth 2.0 Authorization Code with PKCE flow for Spotify Web API.
 * 
 * SETUP:
 * 1. Go to https://developer.spotify.com/dashboard
 * 2. Create a new app (or use your existing Hitster app)
 * 3. Add your redirect URI (e.g., http://127.0.0.1:5173/callback)
 * 4. Copy your Client ID and paste it below
 */

// ⚠️ IMPORTANT: Replace with your Spotify App's Client ID
const CLIENT_ID = 'd924c985a04941a1bfc8ffd87fa2e335';

// Redirect URI - must match exactly what's in your Spotify Dashboard
const REDIRECT_URI = window.location.origin + '/callback';

// Scopes required for playback control
const SCOPES = [
  'user-modify-playback-state',  // Start/stop/skip playback
  'user-read-playback-state',    // Get current playback info
  'user-read-currently-playing', // Get currently playing track
  'streaming',                   // Web Playback SDK
  'user-read-email',             // Required by Web Playback SDK
  'user-read-private'            // Required by Web Playback SDK
].join(' ');

// Token storage keys
const TOKEN_KEY = 'hitster_spotify_token';
const TOKEN_EXPIRY_KEY = 'hitster_spotify_token_expiry';
const CODE_VERIFIER_KEY = 'hitster_code_verifier';

/**
 * Generate a random string for PKCE code verifier
 */
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], '');
}

/**
 * Generate SHA-256 hash of a string
 */
async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

/**
 * Base64URL encode an ArrayBuffer
 */
function base64urlencode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate PKCE code challenge from verifier
 */
async function generateCodeChallenge(verifier) {
  const hashed = await sha256(verifier);
  return base64urlencode(hashed);
}

/**
 * Redirect user to Spotify authorization page
 */
export async function login() {
  // Generate PKCE code verifier and challenge
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  
  // Store code verifier for later use
  sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);
  
  // Generate state for CSRF protection
  const state = generateRandomString(16);
  sessionStorage.setItem('spotify_auth_state', state);
  
  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  
  window.location.href = authUrl.toString();
}

/**
 * Handle OAuth callback - exchange code for token
 * @returns {Promise<Object|null>} Token info or null if not a callback
 */
export async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  const error = urlParams.get('error');
  
  console.log('handleCallback - code:', code ? 'present' : 'none');
  console.log('handleCallback - state from URL:', state);
  console.log('handleCallback - error:', error);
  
  // Not a callback
  if (!code && !error) {
    console.log('handleCallback - not a callback URL');
    return null;
  }
  
  // Check for errors
  if (error) {
    console.error('Spotify auth error:', error);
    return { error };
  }
  
  // Validate state parameter (CSRF protection)
  const storedState = sessionStorage.getItem('spotify_auth_state');
  console.log('handleCallback - stored state:', storedState);
  if (state !== storedState) {
    console.error('State mismatch - URL state:', state, 'stored state:', storedState);
    return { error: 'state_mismatch' };
  }
  
  // Get stored code verifier
  const codeVerifier = sessionStorage.getItem(CODE_VERIFIER_KEY);
  console.log('handleCallback - code verifier:', codeVerifier ? 'present' : 'MISSING');
  if (!codeVerifier) {
    console.error('No code verifier found in sessionStorage');
    return { error: 'no_code_verifier' };
  }
  
  // Clear session storage
  sessionStorage.removeItem('spotify_auth_state');
  sessionStorage.removeItem(CODE_VERIFIER_KEY);
  
  try {
    // Exchange code for token
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Token exchange failed:', errorData);
      return { error: errorData.error || 'token_exchange_failed' };
    }
    
    const data = await response.json();
    
    // Calculate expiry time
    const expiryTime = Date.now() + (data.expires_in * 1000);
    
    // Store token
    localStorage.setItem(TOKEN_KEY, data.access_token);
    localStorage.setItem(TOKEN_EXPIRY_KEY, expiryTime.toString());
    
    // Clear URL parameters
    window.history.replaceState({}, document.title, window.location.pathname);
    
    return { 
      accessToken: data.access_token, 
      expiresIn: data.expires_in 
    };
    
  } catch (err) {
    console.error('Token exchange error:', err);
    return { error: 'network_error' };
  }
}

/**
 * Get stored access token if valid
 * @returns {string|null} Access token or null if expired/not found
 */
export function getStoredToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
  
  if (!token || !expiry) {
    return null;
  }
  
  // Check if token is expired (with 5 minute buffer)
  const expiryTime = parseInt(expiry, 10);
  const bufferMs = 5 * 60 * 1000; // 5 minutes
  
  if (Date.now() > expiryTime - bufferMs) {
    // Token expired or about to expire
    clearToken();
    return null;
  }
  
  return token;
}

/**
 * Clear stored token (logout)
 */
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

/**
 * Check if user is authenticated
 * @returns {boolean}
 */
export function isAuthenticated() {
  return getStoredToken() !== null;
}

/**
 * Get time until token expires
 * @returns {number} Milliseconds until expiry, or 0 if expired
 */
export function getTokenTimeRemaining() {
  const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
  if (!expiry) return 0;

  const remaining = parseInt(expiry, 10) - Date.now();
  return Math.max(0, remaining);
}

/**
 * Check if a playback mode requires authentication
 * @param {string} mode - 'preview', 'sdk', or 'external'
 * @returns {boolean}
 */
export function isAuthRequired(mode) {
  return mode !== 'preview';
}

/**
 * Check if a playback mode requires Spotify Premium
 * @param {string} mode - 'preview', 'sdk', or 'external'
 * @returns {boolean}
 */
export function isPremiumRequired(mode) {
  return mode !== 'preview';
}
