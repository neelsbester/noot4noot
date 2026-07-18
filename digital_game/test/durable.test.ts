import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { GameAction } from "../src/domain/types";
import type { RoomDurableObject } from "../src/durable/room";
import { randomToken } from "../src/security";

const NOW = Date.now();

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("DirectoryDurableObject", () => {
  it("creates, redeems, validates, and revokes a scoped invite", async () => {
    const directory = env.DIRECTORY.getByName(unique("directory"));
    const created = await directory.createInvite({
      label: "Friday group",
      lifetime: "day",
      maxRedemptions: 20,
      now: NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.invite.expiresAt).toBe(NOW + 24 * 60 * 60 * 1000);

    const redeemed = await directory.redeemInvite(created.value.token, null, unique("ip"), NOW);
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(await directory.validateAccess(redeemed.value.sessionToken, NOW + 1)).toMatchObject({ ok: true });

    expect(await directory.revokeInvite(created.value.invite.id, NOW + 2)).toMatchObject({ ok: true });
    expect(await directory.validateAccess(redeemed.value.sessionToken, NOW + 3)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("enforces a redemption cap atomically", async () => {
    const directory = env.DIRECTORY.getByName(unique("directory"));
    const created = await directory.createInvite({
      label: "One browser",
      lifetime: "month",
      maxRedemptions: 1,
      now: NOW,
    });
    if (!created.ok) throw new Error("invite setup failed");
    const [first, second] = await Promise.all([
      directory.redeemInvite(created.value.token, null, unique("ip"), NOW),
      directory.redeemInvite(created.value.token, null, unique("ip"), NOW),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: { code: "invite_limit_reached" },
    });
  });
});

describe("RoomDurableObject", () => {
  it("keeps concurrent joins and accepts only one mutation at a revision", async () => {
    const room = env.ROOMS.getByName(unique("concurrent-room"));
    const hostToken = randomToken();
    expect((await room.initialize({ code: "RAC2", hostToken, settings: {}, now: NOW })).ok).toBe(true);
    const alphaToken = randomToken();
    const bravoToken = randomToken();
    const [alpha, bravo] = await Promise.all([
      room.join({ name: "Alpha", teamToken: alphaToken, requestId: unique("join"), now: NOW + 1 }),
      room.join({ name: "Bravo", teamToken: bravoToken, requestId: unique("join"), now: NOW + 1 }),
    ]);
    if (!alpha.ok || !bravo.ok) throw new Error("concurrent join failed");
    const before = await requiredSnapshot(room, hostToken, false);
    expect(before.teams.map((team) => team.name).sort()).toEqual(["Alpha", "Bravo"]);
    const [first, second] = await Promise.all([
      room.act({
        token: alphaToken,
        controllerMode: false,
        actionId: unique("action"),
        expectedRevision: before.room.revision,
        action: { type: "set_ready", teamId: alpha.value.teamId, ready: true },
        now: NOW + 2,
      }),
      room.act({
        token: bravoToken,
        controllerMode: false,
        actionId: unique("action"),
        expectedRevision: before.room.revision,
        action: { type: "set_ready", teamId: bravo.value.teamId, ready: true },
        now: NOW + 2,
      }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: { code: "stale_state" },
    });
  });

  it("persists actions, deduplicates retries, and protects mystery metadata", async () => {
    const code = "TST2";
    const room = env.ROOMS.getByName(unique("room"));
    const hostToken = randomToken();
    const alphaToken = randomToken();
    const bravoToken = randomToken();
    const initialized = await room.initialize({ code, hostToken, settings: {}, now: NOW });
    expect(initialized.ok).toBe(true);
    expect(initialized.ok && initialized.value.viewer.playbackOwner).toBe(true);

    const alpha = await room.join({ name: "Alpha", teamToken: alphaToken, requestId: unique("join"), now: NOW + 1 });
    const bravo = await room.join({ name: "Bravo", teamToken: bravoToken, requestId: unique("join"), now: NOW + 2 });
    if (!alpha.ok || !bravo.ok) throw new Error("team setup failed");

    const host = await requiredSnapshot(room, hostToken, false);
    const controllerState = await requiredSnapshot(room, alphaToken, true);
    expect(host.viewer.role).toBe("host");
    expect(controllerState.viewer.role).toBe("controller");

    const alphaReady = await act(room, alphaToken, false, host.room.revision, {
      type: "set_ready",
      teamId: alpha.value.teamId,
      ready: true,
    });
    const bravoReady = await act(room, bravoToken, false, alphaReady.room.revision, {
      type: "set_ready",
      teamId: bravo.value.teamId,
      ready: true,
    });
    await act(room, alphaToken, true, bravoReady.room.revision, { type: "start_game" });

    const hostPlaying = await requiredSnapshot(room, hostToken, false);
    const alphaState = await requiredSnapshot(room, alphaToken, false);
    const controllerPlaying = await requiredSnapshot(room, alphaToken, true);
    expect(hostPlaying.round?.song).toHaveProperty("spotifyUri");
    expect(alphaState.round?.song).toEqual({ id: "mystery" });
    expect(controllerPlaying.round?.song).toEqual({ id: "mystery" });
    expect(controllerPlaying.can.markPlaybackStarted).toBe(false);

    const playback = await act(room, hostToken, false, hostPlaying.room.revision, { type: "mark_playback_started" });
    const actionId = unique("action");
    const firstBonus = await room.act({
      token: alphaToken,
      controllerMode: true,
      actionId,
      expectedRevision: playback.room.revision,
      action: { type: "award_title_artist_bonus" },
      now: NOW + 20,
    });
    const retryBonus = await room.act({
      token: alphaToken,
      controllerMode: true,
      actionId,
      expectedRevision: playback.room.revision,
      action: { type: "award_title_artist_bonus" },
      now: NOW + 21,
    });
    expect(firstBonus).toEqual(retryBonus);
    const final = await requiredSnapshot(room, alphaToken, false);
    expect(final.teams.find((team) => team.id === alpha.value.teamId)?.tokens).toBe(3);
  });

  it("expires and deletes room state through its alarm", async () => {
    const room = env.ROOMS.getByName(unique("expiring-room"));
    const initialized = await room.initialize({
      code: "OLD2",
      hostToken: randomToken(),
      settings: {},
      now: Date.now() - 24 * 60 * 60 * 1000 - 1_000,
    });
    expect(initialized.ok).toBe(true);
    await runInDurableObject(room, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect(await room.summary()).toMatchObject({
      ok: false,
      error: { code: "room_not_found" },
    });
  });
});

describe("Worker HTTP boundary", () => {
  it("runs the owner invite and anonymous create/join flow with secure cookies", async () => {
    const origin = "http://example.test";
    const adminHeaders = {
      "Content-Type": "application/json",
      "Origin": origin,
      "X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com",
    };
    const inviteResponse = await exports.default.fetch(new Request(`${origin}/api/admin/invites`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ label: unique("Browser test"), lifetime: "day", maxRedemptions: 20 }),
    }));
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json<{ token: string }>();

    const redeemResponse = await exports.default.fetch(new Request(`${origin}/api/access/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin },
      body: JSON.stringify({ inviteToken: invite.token }),
    }));
    expect(redeemResponse.status).toBe(200);
    const accessCookie = cookiePair(redeemResponse.headers.get("Set-Cookie"));

    const hostToken = randomToken();
    const createResponse = await exports.default.fetch(new Request(`${origin}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin, "Cookie": accessCookie },
      body: JSON.stringify({ hostToken, requestId: unique("create"), settings: {} }),
    }));
    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(createResponse.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const created = await createResponse.json<{ room: { code: string }; viewer: { role: string } }>();
    expect(created.viewer.role).toBe("host");
    const hostCookie = cookiePair(createResponse.headers.get("Set-Cookie"));

    const teamToken = randomToken();
    const joinResponse = await exports.default.fetch(new Request(
      `${origin}/api/rooms/${created.room.code}/teams`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": origin, "Cookie": accessCookie },
        body: JSON.stringify({ name: "Phone Team", teamToken, requestId: unique("join") }),
      },
    ));
    expect(joinResponse.status).toBe(201);
    const teamCookie = cookiePair(joinResponse.headers.get("Set-Cookie"));

    const hostState = await exports.default.fetch(new Request(
      `${origin}/api/rooms/${created.room.code}/state`,
      { headers: { "Cookie": hostCookie } },
    ));
    const teamState = await exports.default.fetch(new Request(
      `${origin}/api/rooms/${created.room.code}/state`,
      { headers: { "Cookie": teamCookie } },
    ));
    expect(hostState.status).toBe(200);
    expect(teamState.status).toBe(200);
    expect(hostState.headers.get("Set-Cookie")).toContain("noot_room=");
    expect(await teamState.json<{ viewer: { role: string; teamId: string } }>()).toMatchObject({
      viewer: { role: "team" },
    });
  });

  it("rejects cross-origin mutations and oversized bodies", async () => {
    const missingOrigin = await exports.default.fetch(new Request("http://example.test/api/access/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(missingOrigin.status).toBe(403);

    const wrongOrigin = await exports.default.fetch(new Request("http://example.test/api/access/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://evil.test" },
      body: "{}",
    }));
    expect(wrongOrigin.status).toBe(403);

    const oversized = await exports.default.fetch(new Request("http://example.test/api/access/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "20000",
        "Origin": "http://example.test",
      },
      body: "{}",
    }));
    expect(oversized.status).toBe(413);
  });

  it("preserves an authenticated WebSocket upgrade through security handling", async () => {
    const origin = "http://socket.test";
    const adminHeaders = {
      "Content-Type": "application/json",
      "Origin": origin,
      "X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com",
    };
    const inviteResponse = await exports.default.fetch(new Request(`${origin}/api/admin/invites`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ label: unique("Socket test"), lifetime: "day", maxRedemptions: 2 }),
    }));
    const invite = await inviteResponse.json<{ token: string }>();
    const redeemResponse = await exports.default.fetch(new Request(`${origin}/api/access/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin },
      body: JSON.stringify({ inviteToken: invite.token }),
    }));
    const accessCookie = cookiePair(redeemResponse.headers.get("Set-Cookie"));
    const createResponse = await exports.default.fetch(new Request(`${origin}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": origin, "Cookie": accessCookie },
      body: JSON.stringify({ hostToken: randomToken(), requestId: unique("create"), settings: {} }),
    }));
    const created = await createResponse.json<{ room: { code: string } }>();
    const roomCookie = cookiePair(createResponse.headers.get("Set-Cookie"));
    const socketResponse = await exports.default.fetch(new Request(
      `${origin}/ws/rooms/${created.room.code}`,
      {
        headers: {
          "Cookie": roomCookie,
          "Origin": origin,
          "Upgrade": "websocket",
        },
      },
    ));
    expect(socketResponse.status).toBe(101);
    expect(socketResponse.webSocket).not.toBeNull();
    socketResponse.webSocket?.accept();
    socketResponse.webSocket?.close(1000, "test complete");
  });
});

async function requiredSnapshot(
  room: DurableObjectStub<RoomDurableObject>,
  token: string,
  controllerMode: boolean,
) {
  const snapshot = await room.snapshot(token, controllerMode);
  if (!snapshot.ok) throw new Error(snapshot.error.error);
  return snapshot.value;
}

async function act(
  room: DurableObjectStub<RoomDurableObject>,
  token: string,
  controllerMode: boolean,
  expectedRevision: number,
  action: GameAction,
) {
  const result = await room.act({
    token,
    controllerMode,
    actionId: unique("action"),
    expectedRevision,
    action,
    now: NOW + expectedRevision + 10,
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.error}`);
  return result.value;
}

function cookiePair(setCookie: string | null): string {
  if (!setCookie) throw new Error("response did not set a cookie");
  return setCookie.split(";")[0] ?? "";
}
