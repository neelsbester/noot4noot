import type {
  AdminDashboard,
  CreatedInvite,
  ErrorPayload,
  RoomSnapshot,
  ServiceResult,
} from "./contracts";
import { isAdminIdentity, requireAccessIdentity } from "./access";
import { accessCookie, readAccessToken, readRoomToken, roomCookie } from "./cookies";
import { DECKS } from "./decks";
import { GameError } from "./domain/errors";
import { hashSecret, randomId, randomToken, secureRandomIndex } from "./security";
import type { DirectoryDurableObject } from "./durable/directory";
import type { RoomDurableObject } from "./durable/room";
import {
  optionalBoolean,
  parseGameAction,
  parseSettings,
  requireInteger,
  requireRecord,
  requireString,
  type JsonRecord,
} from "./validation";

const MAX_BODY_BYTES = 16_384;
const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/u;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{16,80}$/u;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LAB_SEATS = ["lab-host", "lab-team-a", "lab-team-b"] as const;
type LabSeat = typeof LAB_SEATS[number];

export async function handleRequest(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  let response: Response;
  try {
    if (request.method !== "GET" && request.method !== "HEAD") validateMutationOrigin(request, url);
    response = await route(request, url, env, ctx);
  } catch (error) {
    response = errorResponse(error);
  }
  const secured = secureResponse(response, url, request.method, env);
  console.log(JSON.stringify({
    message: "request completed",
    method: request.method,
    path: url.pathname,
    status: secured.status,
    durationMs: Date.now() - startedAt,
    environment: env.ENVIRONMENT,
  }));
  return secured;
}

async function route(
  request: Request,
  url: URL,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    return json({ ok: true, environment: env.ENVIRONMENT });
  }
  if (request.method === "GET" && path === "/api/config") {
    return json({
      spotifyClientId: env.SPOTIFY_CLIENT_ID,
      environment: env.ENVIRONMENT,
      decks: [...DECKS.values()].map((deck) => ({
        id: deck.id,
        name: deck.name,
        songCount: deck.songs.length,
      })),
    });
  }

  const directory = env.DIRECTORY.getByName("directory");
  if (request.method === "GET" && path === "/api/access") {
    const token = readAccessToken(request);
    if (!token) throw new GameError("An invite is required", "access_required", 401);
    return fromService(await directory.validateAccess(token, Date.now()));
  }
  if (request.method === "POST" && path === "/api/access/redeem") {
    const body = await readJson(request);
    const inviteToken = requireString(body, "inviteToken", 32, 128);
    const rateKey = await requestRateKey(request, "redeem");
    const result = await directory.redeemInvite(inviteToken, readAccessToken(request), rateKey, Date.now());
    if (!result.ok) return fromService(result);
    const response = json({ ok: true, expiresAt: result.value.expiresAt });
    response.headers.append(
      "Set-Cookie",
      accessCookie(result.value.sessionToken, result.value.expiresAt, url.protocol === "https:"),
    );
    return response;
  }

  if (path === "/admin" || path === "/admin/" || path === "/admin.html") {
    await requireAdmin(request, env);
    return serveAsset(request, env, "/admin.html");
  }
  if (path === "/test-lab" || path === "/test-lab/" || path === "/test-lab.html") {
    if (env.ENVIRONMENT === "production") {
      throw new GameError("Route not found", "not_found", 404);
    }
    if (env.ENVIRONMENT !== "local") await requireAdmin(request, env);
    return serveAsset(request, env, "/test-lab.html");
  }
  if (path.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    return handleAdmin(request, url, env);
  }

  if (request.method === "POST" && path === "/api/rooms") {
    const accessToken = await requireInviteAccess(request, directory);
    const body = await readJson(request);
    const hostToken = requireSessionToken(body, "hostToken");
    const requestId = requireRequestId(body);
    const settings = parseSettings(body.settings);
    await enforceRateLimit(directory, request, "create-room", 20, 60 * 60 * 1000);
    const allocation = await directory.allocateRoom({
      accessToken,
      requestId,
      now: Date.now(),
    });
    if (!allocation.ok) return fromService(allocation);
    const code = allocation.value.code;
    const room = env.ROOMS.getByName(code);
    const initialized = await room.initialize({
      code,
      hostToken,
      settings,
      now: Date.now(),
    });
    if (!initialized.ok) return fromService(initialized);
    ctx.waitUntil(updateDirectorySummary(directory, room));
    return roomSessionResponse(initialized.value, hostToken, url, env, 201);
  }

  const teamJoin = path.match(/^\/api\/rooms\/([^/]+)\/teams$/u);
  if (request.method === "POST" && teamJoin?.[1]) {
    await requireInviteAccess(request, directory);
    await enforceRateLimit(directory, request, "join-room", 40, 60 * 60 * 1000);
    const code = normalizeRoomCode(teamJoin[1]);
    const body = await readJson(request);
    const teamToken = requireSessionToken(body, "teamToken");
    const room = env.ROOMS.getByName(code);
    const joined = await room.join({
      name: requireString(body, "name", 2, 80),
      teamToken,
      requestId: requireRequestId(body),
      now: Date.now(),
    });
    if (!joined.ok) return fromService(joined);
    const snapshot = await room.snapshot(teamToken, false);
    if (!snapshot.ok) return fromService(snapshot);
    ctx.waitUntil(updateDirectorySummary(directory, room));
    return roomSessionResponse(snapshot.value, teamToken, url, env, 201);
  }

  const roomState = path.match(/^\/api\/rooms\/([^/]+)\/state$/u);
  if (request.method === "GET" && roomState?.[1]) {
    const code = normalizeRoomCode(roomState[1]);
    const token = requireRoomSession(request, code, labSeat(url, env));
    const room = env.ROOMS.getByName(code);
    const result = await room.snapshot(token, url.searchParams.get("mode") === "controller");
    return result.ok
      ? roomSessionResponse(result.value, token, url, env, 200)
      : fromService(result);
  }

  const roomActions = path.match(/^\/api\/rooms\/([^/]+)\/actions$/u);
  if (request.method === "POST" && roomActions?.[1]) {
    const code = normalizeRoomCode(roomActions[1]);
    const token = requireRoomSession(request, code, labSeat(url, env));
    const body = await readJson(request);
    const action = parseGameAction(body.action);
    const result = await env.ROOMS.getByName(code).act({
      token,
      controllerMode: optionalBoolean(body, "controllerMode", false),
      actionId: requireRequestId(body, "actionId"),
      expectedRevision: requireInteger(body, "expectedRevision", 0, Number.MAX_SAFE_INTEGER),
      action,
      now: Date.now(),
    });
    if (result.ok) ctx.waitUntil(updateDirectorySummary(directory, env.ROOMS.getByName(code)));
    return result.ok
      ? roomSessionResponse(result.value, token, url, env, 200)
      : fromService(result);
  }

  const socketPath = path.match(/^\/ws\/rooms\/([^/]+)$/u);
  if (request.method === "GET" && socketPath?.[1]) {
    const code = normalizeRoomCode(socketPath[1]);
    requireRoomSession(request, code, labSeat(url, env));
    return env.ROOMS.getByName(code).fetch(request);
  }

  if (path.startsWith("/api/")) {
    return json({ error: "Route not found", code: "not_found" } satisfies ErrorPayload, 404);
  }
  return servePage(request, env, path);
}

async function handleAdmin(request: Request, url: URL, env: CloudflareEnv): Promise<Response> {
  const path = url.pathname;
  const directory = env.DIRECTORY.getByName("directory");
  if (request.method === "POST" && path === "/api/admin/test-lab") {
    if (env.ENVIRONMENT === "production") {
      throw new GameError("Admin route not found", "not_found", 404);
    }
    await readJson(request);
    return createTestLab(env, directory, url);
  }
  if (request.method === "GET" && path === "/api/admin/dashboard") {
    return json(await directory.dashboard() satisfies AdminDashboard);
  }
  if (request.method === "POST" && path === "/api/admin/invites") {
    const body = await readJson(request);
    const lifetime = requireString(body, "lifetime", 3, 20);
    if (!["day", "month", "indefinite"].includes(lifetime)) {
      throw new GameError("Choose a valid invite lifetime", "invalid_invite_lifetime");
    }
    const result = await directory.createInvite({
      label: requireString(body, "label", 2, 80),
      lifetime: lifetime as "day" | "month" | "indefinite",
      maxRedemptions: body.maxRedemptions === undefined
        ? 20
        : requireInteger(body, "maxRedemptions", 1, 1_000),
      now: Date.now(),
    });
    if (!result.ok) return fromService(result);
    return json({
      invite: result.value.invite,
      token: result.value.token,
      url: `${url.origin}/?invite=${encodeURIComponent(result.value.token)}`,
    } satisfies CreatedInvite & { url: string }, 201);
  }
  const revoke = path.match(/^\/api\/admin\/invites\/([^/]+)\/revoke$/u);
  if (request.method === "POST" && revoke?.[1]) {
    return fromService(await directory.revokeInvite(decodeURIComponent(revoke[1]), Date.now()));
  }
  const close = path.match(/^\/api\/admin\/rooms\/([^/]+)\/close$/u);
  if (request.method === "POST" && close?.[1]) {
    const code = normalizeRoomCode(close[1]);
    const result = await env.ROOMS.getByName(code).adminClose(Date.now());
    if (result.ok) await directory.updateRoomSummary(result.value);
    return fromService(result);
  }
  return json({ error: "Admin route not found", code: "not_found" } satisfies ErrorPayload, 404);
}

async function createTestLab(
  env: CloudflareEnv,
  directory: DurableObjectStub<DirectoryDurableObject>,
  url: URL,
): Promise<Response> {
  const now = Date.now();
  const hostToken = randomToken();
  const teamAToken = randomToken();
  const teamBToken = randomToken();
  let room: DurableObjectStub<RoomDurableObject> | null = null;
  let hostSnapshot: RoomSnapshot | null = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomRoomCode();
    const candidate = env.ROOMS.getByName(code);
    const existing = await candidate.summary();
    if (existing.ok) continue;
    const initialized = await candidate.initialize({
      code,
      hostToken,
      settings: {},
      now,
    });
    if (!initialized.ok) continue;
    room = candidate;
    hostSnapshot = initialized.value;
    break;
  }
  if (!room || !hostSnapshot) {
    throw new GameError("Could not create a test room", "room_allocation_failed", 503);
  }

  const teamA = await room.join({
    name: "Needle Crew",
    teamToken: teamAToken,
    requestId: randomId(),
    now: now + 1,
  });
  if (!teamA.ok) return fromService(teamA);
  const teamB = await room.join({
    name: "Bassline Club",
    teamToken: teamBToken,
    requestId: randomId(),
    now: now + 2,
  });
  if (!teamB.ok) return fromService(teamB);
  await updateDirectorySummary(directory, room);

  const response = json({
    room: hostSnapshot.room.code,
    phase: "lobby",
    teams: [
      { id: teamA.value.teamId, name: "Needle Crew", seat: "lab-team-a" },
      { id: teamB.value.teamId, name: "Bassline Club", seat: "lab-team-b" },
    ],
  }, 201);
  const secure = url.protocol === "https:";
  response.headers.append(
    "Set-Cookie",
    roomCookie(hostSnapshot.room.code, hostToken, hostSnapshot.room.expiresAt, secure, "lab-host"),
  );
  response.headers.append(
    "Set-Cookie",
    roomCookie(hostSnapshot.room.code, teamAToken, hostSnapshot.room.expiresAt, secure, "lab-team-a"),
  );
  response.headers.append(
    "Set-Cookie",
    roomCookie(hostSnapshot.room.code, teamBToken, hostSnapshot.room.expiresAt, secure, "lab-team-b"),
  );
  return response;
}

async function requireInviteAccess(
  request: Request,
  directory: DurableObjectStub<DirectoryDurableObject>,
): Promise<string> {
  const token = readAccessToken(request);
  if (!token) throw new GameError("An invite is required", "access_required", 401);
  const access = await directory.validateAccess(token, Date.now());
  if (!access.ok) throw new GameError(access.error.error, access.error.code, access.status);
  return token;
}

async function enforceRateLimit(
  directory: DurableObjectStub<DirectoryDurableObject>,
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const key = await requestRateKey(request, scope);
  const result = await directory.consumeRateLimit(key, limit, windowMs, Date.now());
  if (!result.ok) throw new GameError(result.error.error, result.error.code, result.status);
}

async function requestRateKey(request: Request, scope: string): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP") ?? "local";
  return `${scope}:${await hashSecret(address)}`;
}

async function requireAdmin(request: Request, env: CloudflareEnv): Promise<void> {
  if (env.ENVIRONMENT === "local") {
    const email = request.headers.get("X-Noot4Noot-Admin-Email");
    if (email?.toLocaleLowerCase() === env.ADMIN_EMAIL.toLocaleLowerCase()) return;
    throw new GameError("Owner access is required", "admin_required", 403);
  }
  const identity = await requireAccessIdentity(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  if (!isAdminIdentity(
    identity,
    env.ADMIN_EMAIL,
    env.ENVIRONMENT,
    env.ACCESS_AUTOMATION_CLIENT_ID,
  )) {
    throw new GameError("Owner access is required", "admin_required", 403);
  }
}

function requireRoomSession(request: Request, code: string, seat: LabSeat | null = null): string {
  const token = readRoomToken(request, code, seat);
  if (!token) throw new GameError("Room session is invalid", "invalid_session", 401);
  return token;
}

function labSeat(url: URL, env: CloudflareEnv): LabSeat | null {
  const seat = url.searchParams.get("seat");
  if (seat === null) return null;
  if (env.ENVIRONMENT === "production" || !isLabSeat(seat)) {
    throw new GameError("Room session is invalid", "invalid_session", 401);
  }
  return seat;
}

function isLabSeat(value: string | null): value is LabSeat {
  return LAB_SEATS.includes(value as LabSeat);
}

function randomRoomCode(): string {
  return Array.from(
    { length: 4 },
    () => ROOM_ALPHABET[secureRandomIndex(ROOM_ALPHABET.length)] ?? "A",
  ).join("");
}

function normalizeRoomCode(value: string): string {
  const code = decodeURIComponent(value).trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) throw new GameError("Room not found", "room_not_found", 404);
  return code;
}

function requireSessionToken(body: JsonRecord, key: string): string {
  const token = requireString(body, key, 40, 128);
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new GameError(`${key} is invalid`, "invalid_request");
  return token;
}

function requireRequestId(body: JsonRecord, key = "requestId"): string {
  const requestId = requireString(body, key, 16, 80);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new GameError(`${key} is invalid`, "invalid_request");
  return requestId;
}

async function updateDirectorySummary(
  directory: DurableObjectStub<DirectoryDurableObject>,
  room: DurableObjectStub<RoomDurableObject>,
): Promise<void> {
  const summary = await room.summary();
  if (summary.ok) await directory.updateRoomSummary(summary.value);
}

function roomSessionResponse(
  snapshot: RoomSnapshot,
  token: string,
  url: URL,
  env: CloudflareEnv,
  status: number,
): Response {
  const response = json(snapshot, status);
  response.headers.append(
    "Set-Cookie",
    roomCookie(
      snapshot.room.code,
      token,
      snapshot.room.expiresAt,
      url.protocol === "https:",
      labSeat(url, env),
    ),
  );
  return response;
}

async function readJson(request: Request): Promise<JsonRecord> {
  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new GameError("Content-Type must be application/json", "invalid_content_type", 415);
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new GameError("Request is too large", "request_too_large", 413);
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      throw new GameError("Request body is invalid", "invalid_request");
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new GameError("Request is too large", "request_too_large", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return requireRecord(text ? JSON.parse(text) : {});
  } catch (error) {
    if (error instanceof GameError) throw error;
    throw new GameError("Request contains invalid JSON", "invalid_json");
  }
}

function validateMutationOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  if (origin !== url.origin) {
    throw new GameError("Cross-origin request blocked", "invalid_origin", 403);
  }
}

function servePage(request: Request, env: CloudflareEnv, path: string): Promise<Response> {
  const pages: Record<string, string> = {
    "/": "/index.html",
    "/host": "/host.html",
    "/host/": "/host.html",
    "/callback": "/host.html",
    "/team": "/team.html",
    "/team/": "/team.html",
  };
  return serveAsset(request, env, pages[path] ?? path);
}

function serveAsset(request: Request, env: CloudflareEnv, path: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  return env.ASSETS.fetch(new Request(url, request));
}

function fromService<T>(result: ServiceResult<T>): Response {
  return result.ok ? json(result.value) : json(result.error, result.status);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof GameError) {
    return json({ error: error.message, code: error.code } satisfies ErrorPayload, error.status);
  }
  console.error(JSON.stringify({
    message: "unhandled request error",
    error: error instanceof Error ? error.message : String(error),
  }));
  return json({ error: "Internal server error", code: "server_error" } satisfies ErrorPayload, 500);
}

function secureResponse(
  response: Response,
  url: URL,
  method: string,
  env: CloudflareEnv,
): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  const framedLabSeat = env.ENVIRONMENT !== "production"
    && isLabSeat(url.searchParams.get("seat"))
    && ["/host", "/host/", "/team", "/team/"].includes(url.pathname);
  const labShell = env.ENVIRONMENT !== "production"
    && ["/test-lab", "/test-lab/", "/test-lab.html"].includes(url.pathname);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("X-Frame-Options", framedLabSeat ? "SAMEORIGIN" : "DENY");
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      `frame-ancestors ${framedLabSeat ? "'self'" : "'none'"}`,
      "form-action 'self' https://accounts.spotify.com",
      "script-src 'self' https://sdk.scdn.co",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https://accounts.spotify.com https://api.spotify.com wss://*.spotify.com",
      `frame-src ${labShell ? "'self' " : ""}https://sdk.scdn.co`,
      "media-src 'self' blob: https://*.spotifycdn.com",
    ].join("; "),
  );
  if (url.protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (url.pathname.startsWith("/api/") || method !== "GET") headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
