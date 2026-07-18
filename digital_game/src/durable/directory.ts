import { DurableObject } from "cloudflare:workers";
import type {
  AdminDashboard,
  AllocateRoomInput,
  CreateInviteInput,
  CreatedInvite,
  InviteSummary,
  RedeemedAccess,
  RoomSummary,
  ServiceResult,
} from "../contracts";
import { GameError } from "../domain/errors";
import { hashSecret, hashesEqual, randomId, randomToken, secureRandomIndex } from "../security";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface InviteRow extends Record<string, SqlStorageValue> {
  id: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  max_redemptions: number;
  redemption_count: number;
  revoked_at: number | null;
  token_hash: string;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  token_hash: string;
  invite_id: string;
  created_at: number;
  expires_at: number;
}

interface RoomRow extends Record<string, SqlStorageValue> {
  code: string;
  status: string;
  revision: number;
  created_at: number;
  last_activity_at: number;
  team_count: number;
  round_number: number | null;
  winner_team_name: string | null;
}

export class DirectoryDurableObject extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.migrate();
      return Promise.resolve();
    });
  }

  async createInvite(input: CreateInviteInput): Promise<ServiceResult<CreatedInvite>> {
    return this.safe(async () => {
      const label = input.label.trim().replace(/\s+/g, " ");
      if (label.length < 2 || label.length > 80) {
        throw new GameError("Invite label must be 2–80 characters", "invalid_invite_label");
      }
      if (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1 || input.maxRedemptions > 1_000) {
        throw new GameError("Redemption limit must be between 1 and 1000", "invalid_redemption_limit");
      }
      const lifetimeMs = input.lifetime === "day"
        ? DAY_MS
        : input.lifetime === "month"
          ? MONTH_MS
          : null;

      const token = randomToken();
      const tokenHash = await hashSecret(token);
      const invite: InviteSummary = {
        id: randomId(),
        label,
        createdAt: input.now,
        expiresAt: lifetimeMs === null ? null : input.now + lifetimeMs,
        maxRedemptions: input.maxRedemptions,
        redemptionCount: 0,
        revokedAt: null,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO invites
          (id, token_hash, label, created_at, expires_at, max_redemptions, redemption_count, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
        invite.id,
        tokenHash,
        invite.label,
        invite.createdAt,
        invite.expiresAt,
        invite.maxRedemptions,
      );
      return { invite, token };
    });
  }

  async redeemInvite(
    inviteToken: string,
    existingSessionToken: string | null,
    rateLimitKey: string,
    now: number,
  ): Promise<ServiceResult<RedeemedAccess>> {
    return this.safe(async () => {
      if (inviteToken.length < 32 || inviteToken.length > 128) {
        throw new GameError("This invite is not valid", "invalid_invite", 404);
      }
      const tokenHash = await hashSecret(inviteToken);
      const existingHash = existingSessionToken ? await hashSecret(existingSessionToken) : null;
      const sessionToken = randomToken();
      const sessionHash = await hashSecret(sessionToken);
      this.consumeRateLimitInternal(`redeem:${rateLimitKey}`, 12, 10 * 60 * 1000, now);
      const invite = this.ctx.storage.sql
        .exec<InviteRow>("SELECT * FROM invites WHERE token_hash = ?", tokenHash)
        .toArray()[0];
      this.requireActiveInvite(invite, now);

      if (existingSessionToken && existingHash) {
        const existing = this.ctx.storage.sql
          .exec<SessionRow>(
            "SELECT token_hash, invite_id, created_at, expires_at FROM access_sessions WHERE token_hash = ?",
            existingHash,
          )
          .toArray()[0];
        if (existing && existing.invite_id === invite.id && existing.expires_at > now) {
          return { sessionToken: existingSessionToken, expiresAt: existing.expires_at };
        }
      }

      if (invite.redemption_count >= invite.max_redemptions) {
        throw new GameError("This invite has reached its redemption limit", "invite_limit_reached", 403);
      }
      const sessionExpiresAt = Math.min(invite.expires_at ?? now + MONTH_MS, now + MONTH_MS);
      const claimed = this.ctx.storage.sql.exec(
        `UPDATE invites
         SET redemption_count = redemption_count + 1
         WHERE id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND redemption_count < max_redemptions`,
        invite.id,
        now,
      );
      if (claimed.rowsWritten !== 1) {
        throw new GameError("This invite has reached its redemption limit", "invite_limit_reached", 403);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO access_sessions (token_hash, invite_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
        sessionHash,
        invite.id,
        now,
        sessionExpiresAt,
      );
      this.cleanupSessions(now);
      return { sessionToken, expiresAt: sessionExpiresAt };
    });
  }

  async validateAccess(sessionToken: string, now: number): Promise<ServiceResult<{ inviteId: string }>> {
    return this.safe(async () => {
      const sessionHash = await this.hashAccessToken(sessionToken);
      const session = this.requireAccessHash(sessionHash, now);
      return { inviteId: session.invite_id };
    });
  }

  async allocateRoom(input: AllocateRoomInput): Promise<ServiceResult<{ code: string }>> {
    return this.safe(async () => {
      const accessHash = await this.hashAccessToken(input.accessToken);
      const session = this.requireAccessHash(accessHash, input.now);
      if (!/^[A-Za-z0-9-]{16,80}$/u.test(input.requestId)) {
        throw new GameError("Room request ID is invalid", "invalid_request_id");
      }
      const existing = this.ctx.storage.sql
        .exec<{ room_code: string; session_hash: string }>(
          "SELECT room_code, session_hash FROM room_requests WHERE request_id = ?",
          input.requestId,
        )
        .toArray()[0];
      if (existing) {
        if (!hashesEqual(accessHash, existing.session_hash)) {
          throw new GameError("Room request ID belongs to another session", "request_conflict", 409);
        }
        return { code: existing.room_code };
      }

      const code = this.newRoomCode();
      this.ctx.storage.sql.exec(
        `INSERT INTO rooms
          (code, status, revision, created_at, last_activity_at, team_count, round_number, winner_team_name)
         VALUES (?, 'pending', -1, ?, ?, 0, NULL, NULL)`,
        code,
        input.now,
        input.now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO room_requests (request_id, session_hash, room_code, created_at)
         VALUES (?, ?, ?, ?)`,
        input.requestId,
        session.token_hash,
        code,
        input.now,
      );
      this.ctx.storage.sql.exec("DELETE FROM room_requests WHERE created_at <= ?", input.now - DAY_MS);
      return { code };
    });
  }

  updateRoomSummary(summary: RoomSummary): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms
        (code, status, revision, created_at, last_activity_at, team_count, round_number, winner_team_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         status = excluded.status,
         revision = excluded.revision,
         last_activity_at = excluded.last_activity_at,
         team_count = excluded.team_count,
         round_number = excluded.round_number,
         winner_team_name = excluded.winner_team_name
       WHERE excluded.revision >= rooms.revision`,
      summary.code,
      summary.status,
      summary.revision,
      summary.createdAt,
      summary.lastActivityAt,
      summary.teamCount,
      summary.roundNumber,
      summary.winnerTeamName,
    );
    this.cleanupOperationalRows(Date.now());
  }

  removeRoom(code: string): void {
    this.ctx.storage.sql.exec("DELETE FROM rooms WHERE code = ?", code);
  }

  revokeInvite(inviteId: string, now: number): ServiceResult<{ revoked: true }> {
    return this.safeSync(() => {
      const result = this.ctx.storage.sql.exec(
        "UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
        now,
        inviteId,
      );
      if (result.rowsWritten === 0) throw new GameError("Invite not found", "invite_not_found", 404);
      return { revoked: true };
    });
  }

  dashboard(): AdminDashboard {
    this.cleanupOperationalRows(Date.now());
    const invites = this.ctx.storage.sql
      .exec<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC LIMIT 250")
      .toArray()
      .map(toInviteSummary);
    const rooms = this.ctx.storage.sql
      .exec<RoomRow>("SELECT * FROM rooms ORDER BY last_activity_at DESC LIMIT 250")
      .toArray()
      .map(toRoomSummary);
    return { invites, rooms };
  }

  consumeRateLimit(key: string, limit: number, windowMs: number, now: number): ServiceResult<{ allowed: true }> {
    return this.safeSync(() => {
      this.consumeRateLimitInternal(key, limit, windowMs, now);
      return { allowed: true };
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_redemptions INTEGER NOT NULL,
        redemption_count INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS access_sessions (
        token_hash TEXT PRIMARY KEY,
        invite_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS access_sessions_invite ON access_sessions(invite_id);
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        team_count INTEGER NOT NULL,
        round_number INTEGER,
        winner_team_name TEXT
      );
      CREATE TABLE IF NOT EXISTS room_requests (
        request_id TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL,
        room_code TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `);
    const roomColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(rooms)")
      .toArray();
    if (!roomColumns.some((column) => column.name === "revision")) {
      this.ctx.storage.sql.exec("ALTER TABLE rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT -1");
    }
  }

  private async hashAccessToken(sessionToken: string): Promise<string> {
    if (sessionToken.length < 32 || sessionToken.length > 128) {
      throw new GameError("An invite is required", "access_required", 401);
    }
    return hashSecret(sessionToken);
  }

  private requireAccessHash(tokenHash: string, now: number): SessionRow {
    const session = this.ctx.storage.sql
      .exec<SessionRow>(
        `SELECT s.token_hash, s.invite_id, s.created_at, s.expires_at
         FROM access_sessions s
         JOIN invites i ON i.id = s.invite_id
         WHERE s.token_hash = ?
           AND s.expires_at > ?
           AND i.revoked_at IS NULL
           AND (i.expires_at IS NULL OR i.expires_at > ?)`,
        tokenHash,
        now,
        now,
      )
      .toArray()[0];
    if (!session) throw new GameError("Your invite access has expired", "access_required", 401);
    return session;
  }

  private requireActiveInvite(invite: InviteRow | undefined, now: number): asserts invite is InviteRow {
    if (!invite || invite.revoked_at !== null || (invite.expires_at !== null && invite.expires_at <= now)) {
      throw new GameError("This invite is not valid", "invalid_invite", 404);
    }
  }

  private cleanupSessions(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM access_sessions WHERE expires_at <= ?", now);
  }

  private cleanupOperationalRows(now: number): void {
    const cutoff = now - DAY_MS;
    this.cleanupSessions(now);
    this.ctx.storage.sql.exec("DELETE FROM room_requests WHERE created_at <= ?", cutoff);
    this.ctx.storage.sql.exec("DELETE FROM rate_limits WHERE window_start <= ?", cutoff);
    this.ctx.storage.sql.exec(
      "DELETE FROM rooms WHERE last_activity_at <= ? AND status IN ('expired', 'closed', 'finished')",
      cutoff,
    );
  }

  private consumeRateLimitInternal(key: string, limit: number, windowMs: number, now: number): void {
    const row = this.ctx.storage.sql
      .exec<{ window_start: number; count: number }>(
        "SELECT window_start, count FROM rate_limits WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (!row || now - row.window_start >= windowMs) {
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        key,
        now,
      );
      return;
    }
    if (row.count >= limit) throw new GameError("Too many attempts. Try again later.", "rate_limited", 429);
    this.ctx.storage.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE key = ?", key);
  }

  private newRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let code = "";
      for (let index = 0; index < 4; index += 1) {
        code += ROOM_ALPHABET.charAt(secureRandomIndex(ROOM_ALPHABET.length));
      }
      const exists = this.ctx.storage.sql
        .exec<{ present: number }>("SELECT 1 AS present FROM rooms WHERE code = ?", code)
        .toArray()[0];
      if (!exists) return code;
    }
    throw new GameError("Unable to allocate a room code", "room_code_exhausted", 503);
  }

  private async safe<T>(operation: () => Promise<T>): Promise<ServiceResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return toFailure(error);
    }
  }

  private safeSync<T>(operation: () => T): ServiceResult<T> {
    try {
      return { ok: true, value: operation() };
    } catch (error) {
      return toFailure(error);
    }
  }
}

function toInviteSummary(row: InviteRow): InviteSummary {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxRedemptions: row.max_redemptions,
    redemptionCount: row.redemption_count,
    revokedAt: row.revoked_at,
  };
}

function toRoomSummary(row: RoomRow): RoomSummary {
  return {
    code: row.code,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    teamCount: row.team_count,
    roundNumber: row.round_number,
    winnerTeamName: row.winner_team_name,
  };
}

function toFailure(error: unknown): ServiceResult<never> {
  if (error instanceof GameError) {
    return { ok: false, error: { error: error.message, code: error.code }, status: error.status };
  }
  console.error(JSON.stringify({
    message: "directory operation failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  return {
    ok: false,
    error: { error: "The service is temporarily unavailable", code: "service_error" },
    status: 503,
  };
}
