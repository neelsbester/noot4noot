import type { GameAction, GameState, RoomSettings, RoundPhase } from "./domain/types";

export interface ErrorPayload {
  error: string;
  code: string;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorPayload; status: number };

export interface InviteSummary {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  maxRedemptions: number;
  redemptionCount: number;
  revokedAt: number | null;
}

export interface RoomSummary {
  code: string;
  status: string;
  revision: number;
  createdAt: number;
  lastActivityAt: number;
  teamCount: number;
  roundNumber: number | null;
  winnerTeamName: string | null;
}

export interface AdminDashboard {
  invites: InviteSummary[];
  rooms: RoomSummary[];
}

export interface CreateInviteInput {
  label: string;
  lifetime: "day" | "month" | "indefinite";
  maxRedemptions: number;
  now: number;
}

export interface CreatedInvite {
  invite: InviteSummary;
  token: string;
}

export interface RedeemedAccess {
  sessionToken: string;
  expiresAt: number;
}

export interface AllocateRoomInput {
  accessToken: string;
  requestId: string;
  now: number;
}

export interface RoomInitialization {
  code: string;
  hostToken: string;
  settings: Partial<RoomSettings>;
  now: number;
}

export interface TeamJoinInput {
  name: string;
  teamToken: string;
  requestId: string;
  now: number;
}

export interface TeamJoinResult {
  teamId: string;
}

export interface RoomActionInput {
  token: string;
  controllerMode: boolean;
  actionId: string;
  expectedRevision: number;
  action: GameAction;
  now: number;
}

export interface PublicSong {
  id: string;
  title: string;
  artist: string;
  year: number;
  spotifyUrl: string;
  spotifyUri: string;
}

export interface RoomSnapshot {
  room: {
    code: string;
    status: GameState["status"];
    revision: number;
    settings: RoomSettings;
    expiresAt: number;
    winnerTeamId: string | null;
    finishReason: string | null;
  };
  viewer: {
    role: "host" | "controller" | "team";
    teamId: string | null;
    playbackOwner: boolean;
  };
  teams: Array<{
    id: string;
    name: string;
    ready: boolean;
    tokens: number;
    cardCount: number;
    isActive: boolean;
  }>;
  round: null | {
    number: number;
    phase: RoundPhase;
    activeTeamId: string;
    playbackStarted: boolean;
    placement: number | null;
    challengeTeamId: string | null;
    challengePlacement: number | null;
    challengePassCount: number;
    challengePassTotal: number;
    viewerPassed: boolean;
    challengeDeadlineAt: number | null;
    correctPlacement: number | null;
    outcome: string | null;
    winnerTeamId: string | null;
    bonusAwarded: boolean;
    song: { id: "mystery" } | Pick<PublicSong, "id" | "spotifyUri" | "spotifyUrl"> | PublicSong;
  };
  activeTimeline: PublicSong[];
  viewerTimeline: PublicSong[];
  can: Record<string, boolean>;
}
