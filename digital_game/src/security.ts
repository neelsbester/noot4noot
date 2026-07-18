const encoder = new TextEncoder();

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function secureRandomIndex(upperExclusive: number): number {
  if (!Number.isInteger(upperExclusive) || upperExclusive <= 0) {
    throw new Error("upperExclusive must be a positive integer");
  }
  const range = 0x1_0000_0000;
  const limit = range - (range % upperExclusive);
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while ((value[0] ?? range) >= limit);
  return (value[0] ?? 0) % upperExclusive;
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySecret(secret: string, expectedHash: string): Promise<boolean> {
  const actualHash = await hashSecret(secret);
  return hashesEqual(actualHash, expectedHash);
}

export function hashesEqual(actualHash: string, expectedHash: string): boolean {
  if (actualHash.length !== expectedHash.length) return false;
  return crypto.subtle.timingSafeEqual(encoder.encode(actualHash), encoder.encode(expectedHash));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
