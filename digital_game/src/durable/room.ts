import { DurableObject } from "cloudflare:workers";
import type {
  RoomActionInput,
  RoomInitialization,
  RoomSnapshot,
  RoomSummary,
  ServiceResult,
  TeamJoinInput,
  TeamJoinResult,
} from "../contracts";
import { addTeam, applyGameAction, createGameState } from "../domain/game";
import { GameError } from "../domain/errors";
import type { ActionContext, GameState } from "../domain/types";
import { MILLENNIAL_ANTHEMS, SONGS } from "../decks";
import { readRoomToken } from "../cookies";
import { hashSecret, hashesEqual, randomId, secureRandomIndex } from "../security";
import { serializeRoom, type Viewer } from "../serialize";

interface StateRow extends Record<string, SqlStorageValue> {
  json: string;
}

interface IdempotencyRow extends Record<string, SqlStorageValue> {
  actor_key: string;
  result_json: string;
}

interface SocketAttachment {
  role: Viewer["role"];
  teamId: string | null;
  playbackOwner: boolean;
}

export class RoomDurableObject extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.migrate();
      return Promise.resolve();
    });
  }

  async initialize(input: RoomInitialization): Promise<ServiceResult<RoomSnapshot>> {
    return this.safe(async () => {
      const tokenHash = await hashSecret(input.hostToken);
      const existing = this.loadStateOrNull();
      if (existing) {
        if (existing.roomCode !== input.code) throw new GameError("Room code conflict", "room_conflict", 409);
        const viewer = this.authenticateHash(existing, tokenHash, false);
        if (viewer.role !== "host") throw new GameError("Room already exists", "room_conflict", 409);
        return serializeRoom(existing, SONGS, viewer);
      }
      const state = createGameState(
        input.code,
        tokenHash,
        input.settings,
        MILLENNIAL_ANTHEMS,
        input.now,
        secureRandomIndex,
      );
      this.saveState(state);
      await this.scheduleAlarm(state);
      return serializeRoom(state, SONGS, { role: "host", teamId: null, playbackOwner: true });
    });
  }

  async join(input: TeamJoinInput): Promise<ServiceResult<TeamJoinResult>> {
    return this.safe(async () => {
      this.validateRequestId(input.requestId);
      const tokenHash = await hashSecret(input.teamToken);
      const state = this.loadState();
      const previous = this.ctx.storage.sql
        .exec<{ team_id: string; token_hash: string }>(
          "SELECT team_id, token_hash FROM join_requests WHERE request_id = ?",
          input.requestId,
        )
        .toArray()[0];
      if (previous) {
        if (!hashesEqual(tokenHash, previous.token_hash)) {
          throw new GameError("Join request belongs to another session", "request_conflict", 409);
        }
        return { teamId: previous.team_id };
      }
      const teamId = randomId();
      addTeam(
        state,
        {
          id: teamId,
          name: input.name,
          tokenHash,
          joinedAt: input.now,
        },
        input.now,
      );
      this.saveState(state);
      this.ctx.storage.sql.exec(
        "INSERT INTO join_requests (request_id, team_id, token_hash, created_at) VALUES (?, ?, ?, ?)",
        input.requestId,
        teamId,
        tokenHash,
        input.now,
      );
      this.ctx.storage.sql.exec("DELETE FROM join_requests WHERE created_at <= ?", input.now - 24 * 60 * 60 * 1000);
      await this.scheduleAlarm(state);
      this.broadcast(state.revision);
      return { teamId };
    });
  }

  async snapshot(
    token: string,
    controllerMode: boolean,
  ): Promise<ServiceResult<RoomSnapshot>> {
    return this.safe(async () => {
      const tokenHash = await this.hashSessionToken(token);
      const state = this.loadState();
      const viewer = this.authenticateHash(state, tokenHash, controllerMode);
      return serializeRoom(state, SONGS, viewer);
    });
  }

  async act(input: RoomActionInput): Promise<ServiceResult<RoomSnapshot>> {
    return this.safe(async () => {
      this.validateRequestId(input.actionId);
      const tokenHash = await this.hashSessionToken(input.token);
      const state = this.loadState();
      const viewer = this.authenticateHash(state, tokenHash, input.controllerMode);
      const actorKey = viewer.role === "host" ? "host" : `${viewer.role}:${viewer.teamId ?? "none"}`;
      const prior = this.ctx.storage.sql
        .exec<IdempotencyRow>(
          "SELECT actor_key, result_json FROM action_results WHERE action_id = ?",
          input.actionId,
        )
        .toArray()[0];
      if (prior) {
        if (prior.actor_key !== actorKey) throw new GameError("Action ID belongs to another session", "request_conflict", 409);
        return JSON.parse(prior.result_json) as RoomSnapshot;
      }
      if (input.expectedRevision !== state.revision) {
        throw new GameError("The game changed on another device. Try again.", "stale_state", 409);
      }

      const context: ActionContext = {
        now: input.now,
        actor: viewer.role === "host"
          ? { role: "host" }
          : viewer.role === "controller" && viewer.teamId
            ? { role: "controller", teamId: viewer.teamId }
            : viewer.teamId
              ? { role: "team", teamId: viewer.teamId }
              : { role: "admin" },
        randomIndex: secureRandomIndex,
      };
      applyGameAction(state, input.action, SONGS, context);
      this.saveState(state);
      const snapshot = serializeRoom(state, SONGS, viewer);
      this.ctx.storage.sql.exec(
        "INSERT INTO action_results (action_id, actor_key, result_json, created_at) VALUES (?, ?, ?, ?)",
        input.actionId,
        actorKey,
        JSON.stringify(snapshot),
        input.now,
      );
      this.ctx.storage.sql.exec("DELETE FROM action_results WHERE created_at <= ?", input.now - 24 * 60 * 60 * 1000);
      await this.scheduleAlarm(state);
      this.broadcast(state.revision);
      return snapshot;
    });
  }

  async adminClose(now: number): Promise<ServiceResult<RoomSummary>> {
    return this.safe(async () => {
      const state = this.loadState();
      if (state.status !== "expired") {
        applyGameAction(
          state,
          { type: "close_room", reason: "closed_by_admin" },
          SONGS,
          { now, actor: { role: "admin" }, randomIndex: secureRandomIndex },
        );
        this.saveState(state);
        await this.scheduleAlarm(state);
        this.broadcast(state.revision);
      }
      return toSummary(state);
    });
  }

  summary(): ServiceResult<RoomSummary> {
    try {
      return { ok: true, value: toSummary(this.loadState()) };
    } catch (error) {
      return toFailure(error);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "WebSocket upgrade required", code: "upgrade_required" }, { status: 426 });
      }
      const url = new URL(request.url);
      const origin = request.headers.get("Origin");
      if (!origin || origin !== url.origin) {
        return Response.json({ error: "Invalid WebSocket origin", code: "invalid_origin" }, { status: 403 });
      }
      const code = url.pathname.split("/").filter(Boolean).at(-1)?.toUpperCase() ?? "";
      const token = readRoomToken(request, code, url.searchParams.get("seat"));
      if (!token) return Response.json({ error: "Room session required", code: "invalid_session" }, { status: 401 });
      const controllerMode = url.searchParams.get("mode") === "controller";
      const tokenHash = await this.hashSessionToken(token);
      const state = this.loadState();
      const viewer = this.authenticateHash(state, tokenHash, controllerMode);
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [`room:${code}`]);
      server.serializeAttachment({
        role: viewer.role,
        teamId: viewer.teamId,
        playbackOwner: viewer.playbackOwner,
      } satisfies SocketAttachment);
      server.send(JSON.stringify({ type: "revision", revision: state.revision }));
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      const failure = toFailure(error);
      return Response.json(failure.error, { status: failure.status });
    }
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 128) {
      ws.close(1008, "Unsupported message");
      return;
    }
    let attachment: unknown;
    try {
      attachment = ws.deserializeAttachment();
    } catch {
      ws.close(1011, "Session unavailable");
      return;
    }
    if (!isSocketAttachment(attachment)) {
      ws.close(1011, "Session unavailable");
      return;
    }
    if (message === "ping") ws.send(JSON.stringify({ type: "pong" }));
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason);
  }

  override async alarm(): Promise<void> {
    const cleanup = this.ctx.storage.sql
      .exec<{ summary_json: string }>("SELECT summary_json FROM room_cleanup WHERE id = 1")
      .toArray()[0];
    if (cleanup) {
      await this.finishExpiryCleanup(JSON.parse(cleanup.summary_json) as RoomSummary);
      return;
    }
    const state = this.loadStateOrNull();
    if (!state) return;
    const now = Date.now();
    if (now >= state.expiresAt) {
      state.status = "expired";
      state.finishReason = "expired";
      state.revision += 1;
      this.saveState(state);
      const summary = toSummary(state);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO room_cleanup (id, summary_json) VALUES (1, ?)",
        JSON.stringify(summary),
      );
      this.broadcast(state.revision);
      await this.finishExpiryCleanup(summary);
      return;
    }
    const deadline = state.currentRound?.challengeDeadlineAt;
    if (deadline !== null && deadline !== undefined && now >= deadline) {
      applyGameAction(
        state,
        { type: "resolve_timer" },
        SONGS,
        { now, actor: { role: "admin" }, randomIndex: secureRandomIndex },
      );
      this.saveState(state);
      this.broadcast(state.revision);
    }
    await this.scheduleAlarm(state);
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_results (
        action_id TEXT PRIMARY KEY,
        actor_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_results_created ON action_results(created_at);
      CREATE TABLE IF NOT EXISTS join_requests (
        request_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_cleanup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary_json TEXT NOT NULL
      );
    `);
  }

  private loadStateOrNull(): GameState | null {
    const row = this.ctx.storage.sql.exec<StateRow>("SELECT json FROM room_state WHERE id = 1").toArray()[0];
    if (!row) return null;
    const state: unknown = JSON.parse(row.json);
    if (!isGameState(state)) throw new GameError("Room data is invalid", "invalid_room_state", 500);
    return state;
  }

  private loadState(): GameState {
    const state = this.loadStateOrNull();
    if (!state) throw new GameError("Room not found", "room_not_found", 404);
    return state;
  }

  private saveState(state: GameState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO room_state (id, json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      JSON.stringify(state),
    );
  }

  private authenticateHash(
    state: GameState,
    tokenHash: string,
    controllerMode: boolean,
  ): Viewer {
    if (hashesEqual(tokenHash, state.hostTokenHash)) {
      return { role: "host", teamId: null, playbackOwner: true };
    }
    for (const team of state.teams) {
      if (hashesEqual(tokenHash, team.tokenHash)) {
        return {
          role: controllerMode ? "controller" : "team",
          teamId: team.id,
          playbackOwner: false,
        };
      }
    }
    throw new GameError("Room session is invalid", "invalid_session", 401);
  }

  private async hashSessionToken(token: string): Promise<string> {
    if (token.length < 32 || token.length > 128) {
      throw new GameError("Room session is invalid", "invalid_session", 401);
    }
    return hashSecret(token);
  }

  private async scheduleAlarm(state: GameState): Promise<void> {
    if (state.status === "expired") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const deadline = state.currentRound?.challengeDeadlineAt;
    const next = deadline === null || deadline === undefined
      ? state.expiresAt
      : Math.min(deadline, state.expiresAt);
    await this.ctx.storage.setAlarm(next);
  }

  private broadcast(revision: number): void {
    const message = JSON.stringify({ type: "revision", revision });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "Connection reset");
      }
    }
  }

  private validateRequestId(value: string): void {
    if (!/^[A-Za-z0-9-]{16,80}$/u.test(value)) {
      throw new GameError("Request ID is invalid", "invalid_request_id");
    }
  }

  private async safe<T>(operation: () => Promise<T>): Promise<ServiceResult<T>> {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return toFailure(error);
    }
  }

  private async finishExpiryCleanup(summary: RoomSummary): Promise<void> {
    try {
      await this.env.DIRECTORY.getByName("directory").updateRoomSummary(summary);
    } catch (error) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      throw error;
    }
    this.ctx.storage.sql.exec(`
      DELETE FROM action_results;
      DELETE FROM join_requests;
      DELETE FROM room_state;
      DELETE FROM room_cleanup;
    `);
  }
}

function toSummary(state: GameState): RoomSummary {
  const winner = state.winnerTeamId
    ? state.teams.find((team) => team.id === state.winnerTeamId)
    : undefined;
  return {
    code: state.roomCode,
    status: state.status,
    revision: state.revision,
    createdAt: state.createdAt,
    lastActivityAt: state.lastActivityAt,
    teamCount: state.teams.length,
    roundNumber: state.currentRound?.number ?? null,
    winnerTeamName: winner?.name ?? null,
  };
}

function isGameState(value: unknown): value is GameState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GameState>;
  return candidate.schemaVersion === 1
    && typeof candidate.roomCode === "string"
    && typeof candidate.revision === "number"
    && Array.isArray(candidate.teams)
    && Array.isArray(candidate.deckSongIds);
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SocketAttachment>;
  return ["host", "controller", "team"].includes(candidate.role ?? "")
    && (typeof candidate.teamId === "string" || candidate.teamId === null)
    && typeof candidate.playbackOwner === "boolean";
}

type FailureResult = Extract<ServiceResult<never>, { ok: false }>;

function toFailure(error: unknown): FailureResult {
  if (error instanceof GameError) {
    return { ok: false, error: { error: error.message, code: error.code }, status: error.status };
  }
  console.error(JSON.stringify({
    message: "room operation failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  return {
    ok: false,
    error: { error: "The room is temporarily unavailable", code: "service_error" },
    status: 503,
  };
}
