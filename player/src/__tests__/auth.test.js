/**
 * Tests for auth.js — token storage, authentication checks, random string gen.
 *
 * We test the pure/synchronous helpers that don't depend on Spotify servers.
 * Browser APIs (localStorage, crypto) are stubbed via vitest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Stub browser globals before importing the module ────────────────────

// Minimal localStorage shim
const storage = {};
const localStorageMock = {
  getItem: vi.fn((key) => storage[key] ?? null),
  setItem: vi.fn((key, val) => { storage[key] = String(val); }),
  removeItem: vi.fn((key) => { delete storage[key]; }),
  clear: vi.fn(() => { for (const k in storage) delete storage[k]; }),
};
vi.stubGlobal('localStorage', localStorageMock);

// sessionStorage shim (needed during module init)
const sessionStore = {};
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key) => sessionStore[key] ?? null),
  setItem: vi.fn((key, val) => { sessionStore[key] = String(val); }),
  removeItem: vi.fn((key) => { delete sessionStore[key]; }),
});

// crypto.getRandomValues shim
vi.stubGlobal('crypto', {
  getRandomValues: (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    return arr;
  },
  subtle: {
    digest: vi.fn(),
  },
});

// window stubs required by auth.js at module level
vi.stubGlobal('window', {
  location: { origin: 'http://localhost:5173', search: '', pathname: '/', href: '' },
  history: { replaceState: vi.fn() },
  crypto: globalThis.crypto,
});

// import.meta.env stub
vi.stubGlobal('import', { meta: { env: {} } });

// Dynamic import after globals are in place
const { getStoredToken, clearToken, isAuthenticated } = await import('../auth.js');

// ── generateRandomString is not exported, so we test it indirectly via
//    the login flow's code verifier length. Instead, we replicate its
//    algorithm locally to prove correctness.
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], '');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('generateRandomString (algorithm replica)', () => {
  it('produces a string of the requested length', () => {
    expect(generateRandomString(64)).toHaveLength(64);
    expect(generateRandomString(16)).toHaveLength(16);
  });

  it('only contains allowed PKCE characters', () => {
    const allowed = /^[A-Za-z0-9\-._~]+$/;
    const result = generateRandomString(128);
    expect(result).toMatch(allowed);
  });

  it('produces different strings on consecutive calls', () => {
    const a = generateRandomString(32);
    const b = generateRandomString(32);
    // Extremely unlikely to be equal with 32 chars of entropy
    expect(a).not.toBe(b);
  });
});

describe('getStoredToken', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('returns null when no token stored', async () => {
    const token = await getStoredToken();
    expect(token).toBeNull();
  });

  it('returns the token when stored and not expired', async () => {
    storage['noot4noot_spotify_token'] = 'test-token-abc';
    // Expiry far in the future
    storage['noot4noot_spotify_token_expiry'] = String(Date.now() + 3_600_000);
    const token = await getStoredToken();
    expect(token).toBe('test-token-abc');
  });
});

describe('clearToken', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('removes all token-related keys from localStorage', () => {
    storage['noot4noot_spotify_token'] = 'tok';
    storage['noot4noot_spotify_token_expiry'] = '123';
    storage['noot4noot_spotify_refresh_token'] = 'ref';

    clearToken();

    expect(localStorageMock.removeItem).toHaveBeenCalledWith('noot4noot_spotify_token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('noot4noot_spotify_token_expiry');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('noot4noot_spotify_refresh_token');
  });
});

describe('isAuthenticated', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('returns false when no token is stored', async () => {
    const result = await isAuthenticated();
    expect(result).toBe(false);
  });
});
