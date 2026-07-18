export type ChallengeTimer = 0 | 30 | 45 | 60;
export type GameStatus = "lobby" | "playing" | "finished" | "closed" | "expired";
export type RoundPhase = "turn_start" | "placement" | "challenge" | "revealed";
export type RoundOutcome = "active_won" | "challenge_won" | "no_winner";

export interface Song {
  id: string;
  title: string;
  artist: string;
  year: number;
  spotifyUrl: string;
  spotifyUri: string;
}

export interface Deck {
  id: string;
  name: string;
  songs: Song[];
}

export interface RoomSettings {
  deckId: string;
  targetCards: number;
  startingTokens: number;
  challengeTimerSeconds: ChallengeTimer;
  titleArtistBonus: boolean;
}

export interface Team {
  id: string;
  name: string;
  tokenHash: string;
  ready: boolean;
  tokens: number;
  timeline: string[];
  joinedAt: number;
}

export interface GameRound {
  number: number;
  activeTeamId: string;
  songId: string;
  phase: RoundPhase;
  purchaseUsed: boolean;
  playbackStartedAt: number | null;
  placement: number | null;
  challengeTeamId: string | null;
  challengePlacement: number | null;
  challengePassTeamIds: string[];
  challengeDeadlineAt: number | null;
  revealTimelineSongIds: string[] | null;
  correctPlacement: number | null;
  outcome: RoundOutcome | null;
  winnerTeamId: string | null;
  bonusAwarded: boolean;
}

export interface GameState {
  schemaVersion: 1;
  roomCode: string;
  settings: RoomSettings;
  status: GameStatus;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  revision: number;
  hostTokenHash: string;
  teams: Team[];
  activeTeamIndex: number;
  deckSongIds: string[];
  discardedSongIds: string[];
  currentRound: GameRound | null;
  winnerTeamId: string | null;
  finishReason: string | null;
}

export type GameAction =
  | { type: "set_ready"; teamId: string; ready: boolean }
  | { type: "start_game" }
  | { type: "buy_random_card"; teamId: string }
  | { type: "mark_playback_started" }
  | { type: "replace_song"; teamId: string }
  | { type: "place"; teamId: string; slot: number }
  | { type: "lock_placement"; teamId: string }
  | { type: "contest"; teamId: string }
  | { type: "pass_challenge"; teamId: string }
  | { type: "place_challenge"; teamId: string; slot: number }
  | { type: "lock_challenge"; teamId: string }
  | { type: "force_reveal" }
  | { type: "resolve_timer" }
  | { type: "award_title_artist_bonus" }
  | { type: "next_round" }
  | { type: "remove_team"; teamId: string }
  | { type: "rematch" }
  | { type: "close_room"; reason?: string }
  | { type: "expire_room" };

export interface ActionContext {
  now: number;
  actor:
    | { role: "host" }
    | { role: "controller"; teamId: string }
    | { role: "team"; teamId: string }
    | { role: "admin" };
  randomIndex: (upperExclusive: number) => number;
}
