const ACCESS_COOKIE = "noot_access";
const ROOM_COOKIE = "noot_room";

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return null;
}

export function readAccessToken(request: Request): string | null {
  return readCookie(request, ACCESS_COOKIE);
}

export function readRoomToken(request: Request, code: string): string | null {
  const value = readCookie(request, ROOM_COOKIE);
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator < 0 || value.slice(0, separator) !== code) return null;
  return value.slice(separator + 1);
}

export function accessCookie(token: string, expiresAt: number, secure: boolean): string {
  return cookie(ACCESS_COOKIE, token, expiresAt, secure);
}

export function roomCookie(code: string, token: string, expiresAt: number, secure: boolean): string {
  return cookie(ROOM_COOKIE, `${code}.${token}`, expiresAt, secure);
}

export function clearRoomCookie(secure: boolean): string {
  return `${ROOM_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function cookie(name: string, value: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
