import { GameError } from "./errors";
import type {
  ActionContext,
  Deck,
  GameAction,
  GameRound,
  GameState,
  RoomSettings,
  Song,
  Team,
} from "./types";

export const ROOM_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const MAX_TEAMS = 8;
export const MAX_TOKENS = 5;

export const DEFAULT_SETTINGS: RoomSettings = {
  deckId: "millennial-anthems",
  targetCards: 10,
  startingTokens: 2,
  challengeTimerSeconds: 0,
  titleArtistBonus: true,
};

export function validateSettings(input: Partial<RoomSettings>): RoomSettings {
  const settings = { ...DEFAULT_SETTINGS, ...input };
  if (settings.deckId !== "millennial-anthems") {
    throw new GameError("That deck is not available", "invalid_deck");
  }
  if (!Number.isInteger(settings.targetCards) || settings.targetCards < 2 || settings.targetCards > 20) {
    throw new GameError("Target cards must be between 2 and 20", "invalid_target");
  }
  if (!Number.isInteger(settings.startingTokens) || settings.startingTokens < 0 || settings.startingTokens > MAX_TOKENS) {
    throw new GameError("Starting tokens must be between 0 and 5", "invalid_starting_tokens");
  }
  if (![0, 30, 45, 60].includes(settings.challengeTimerSeconds)) {
    throw new GameError("Challenge timer must be off, 30, 45, or 60 seconds", "invalid_timer");
  }
  if (typeof settings.titleArtistBonus !== "boolean") {
    throw new GameError("Title and artist bonus must be enabled or disabled", "invalid_bonus");
  }
  return settings;
}

export function createGameState(
  roomCode: string,
  hostTokenHash: string,
  settingsInput: Partial<RoomSettings>,
  deck: Deck,
  now: number,
  randomIndex: (upperExclusive: number) => number,
): GameState {
  const settings = validateSettings(settingsInput);
  if (deck.id !== settings.deckId || deck.songs.length < MAX_TEAMS + 2) {
    throw new GameError("The selected deck is not playable", "invalid_deck");
  }
  return {
    schemaVersion: 1,
    roomCode,
    settings,
    status: "lobby",
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + ROOM_INACTIVITY_MS,
    revision: 0,
    hostTokenHash,
    teams: [],
    activeTeamIndex: 0,
    deckSongIds: shuffle(deck.songs.map((song) => song.id), randomIndex),
    discardedSongIds: [],
    currentRound: null,
    winnerTeamId: null,
    finishReason: null,
  };
}

export function addTeam(
  state: GameState,
  team: Pick<Team, "id" | "name" | "tokenHash" | "joinedAt">,
  now: number,
): void {
  requireStatus(state, "lobby");
  if (state.teams.length >= MAX_TEAMS) {
    throw new GameError("This room already has 8 teams", "room_full");
  }
  const cleanName = team.name.trim().replace(/\s+/g, " ");
  if (cleanName.length < 2 || cleanName.length > 28) {
    throw new GameError("Team name must be 2–28 characters", "invalid_team_name");
  }
  if (state.teams.some((existing) => existing.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
    throw new GameError("That team name is already in use", "duplicate_team_name");
  }
  state.teams.push({
    ...team,
    name: cleanName,
    ready: false,
    tokens: state.settings.startingTokens,
    timeline: [],
  });
  touch(state, now);
}

export function applyGameAction(
  state: GameState,
  action: GameAction,
  songs: ReadonlyMap<string, Song>,
  context: ActionContext,
): void {
  if (["finished", "closed", "expired"].includes(state.status) && !["rematch", "close_room", "expire_room"].includes(action.type)) {
    throw new GameError("This game is finished", "game_finished");
  }

  switch (action.type) {
    case "set_ready":
      setReady(state, action.teamId, action.ready, context);
      break;
    case "start_game":
      startGame(state, songs, context);
      break;
    case "buy_random_card":
      buyRandomCard(state, action.teamId, songs, context);
      break;
    case "mark_playback_started":
      markPlaybackStarted(state, context);
      break;
    case "replace_song":
      replaceSong(state, action.teamId, context);
      break;
    case "place":
      place(state, action.teamId, action.slot, context, false);
      break;
    case "lock_placement":
      lockPlacement(state, action.teamId, context);
      break;
    case "contest":
      contest(state, action.teamId, context);
      break;
    case "pass_challenge":
      passChallenge(state, action.teamId, songs, context);
      break;
    case "place_challenge":
      place(state, action.teamId, action.slot, context, true);
      break;
    case "lock_challenge":
      lockChallenge(state, action.teamId, songs, context);
      break;
    case "force_reveal":
      forceReveal(state, songs, context);
      break;
    case "resolve_timer":
      resolveTimer(state, songs, context);
      break;
    case "award_title_artist_bonus":
      awardBonus(state, context);
      break;
    case "next_round":
      nextRound(state, context);
      break;
    case "remove_team":
      removeTeam(state, action.teamId, songs, context);
      break;
    case "rematch":
      rematch(state, songs, context);
      break;
    case "close_room":
      requireController(context);
      state.status = "closed";
      state.finishReason = action.reason ?? "closed";
      touch(state, context.now);
      break;
    case "expire_room":
      if (context.actor.role !== "admin") throw new GameError("Only the room system can expire a room", "admin_only", 403);
      state.status = "expired";
      state.finishReason = "expired";
      touch(state, context.now);
      break;
  }
}

function setReady(state: GameState, teamId: string, ready: boolean, context: ActionContext): void {
  requireStatus(state, "lobby");
  requireOwnTeam(context, teamId);
  findTeam(state, teamId).ready = ready;
  touch(state, context.now);
}

function startGame(state: GameState, songs: ReadonlyMap<string, Song>, context: ActionContext): void {
  requireController(context);
  requireStatus(state, "lobby");
  if (state.teams.length < 2) throw new GameError("At least two teams must join before starting", "too_few_teams");
  if (!state.teams.every((team) => team.ready)) throw new GameError("Every team must be ready before starting", "teams_not_ready");
  if (state.deckSongIds.length < state.teams.length + 1) throw new GameError("The deck is too small", "deck_empty");
  for (const team of state.teams) {
    insertSong(team, drawSong(state), songs);
  }
  state.status = "playing";
  state.activeTeamIndex = 0;
  beginRound(state, 1);
  touch(state, context.now);
}

function buyRandomCard(
  state: GameState,
  teamId: string,
  songs: ReadonlyMap<string, Song>,
  context: ActionContext,
): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  if (round.activeTeamId !== teamId || round.phase !== "turn_start") {
    throw new GameError("A random card can only be bought at the start of your turn", "purchase_window_closed");
  }
  if (round.purchaseUsed) throw new GameError("Only one random card may be bought each turn", "purchase_already_used");
  const team = findTeam(state, teamId);
  spendTokens(team, 3);
  insertSong(team, drawSong(state), songs);
  round.purchaseUsed = true;
  if (team.timeline.length >= state.settings.targetCards) finish(state, team.id, "target_reached");
  touch(state, context.now);
}

function markPlaybackStarted(state: GameState, context: ActionContext): void {
  requireHost(context);
  const round = requireRound(state);
  if (round.phase !== "turn_start") throw new GameError("This song has already started", "already_started");
  round.phase = "placement";
  round.playbackStartedAt = context.now;
  touch(state, context.now);
}

function replaceSong(state: GameState, teamId: string, context: ActionContext): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  if (round.activeTeamId !== teamId || round.phase !== "placement" || round.playbackStartedAt === null) {
    throw new GameError("A song can only be replaced after it starts and before placement locks", "replace_window_closed");
  }
  const team = findTeam(state, teamId);
  spendTokens(team, 1);
  state.discardedSongIds.push(round.songId);
  round.songId = drawSong(state);
  round.phase = "turn_start";
  round.playbackStartedAt = null;
  round.placement = null;
  touch(state, context.now);
}

function place(
  state: GameState,
  teamId: string,
  slot: number,
  context: ActionContext,
  challenge: boolean,
): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  const timelineLength = findTeam(state, round.activeTeamId).timeline.length;
  if (!Number.isInteger(slot) || slot < 0 || slot > timelineLength) {
    throw new GameError("That timeline position no longer exists", "invalid_slot");
  }
  if (challenge) {
    if (round.phase !== "challenge" || round.challengeTeamId !== teamId) {
      throw new GameError("Only the contesting team can place here", "not_challenger");
    }
    if (slot === round.placement) throw new GameError("A contest must choose a different position", "same_challenge_slot");
    round.challengePlacement = slot;
  } else {
    if (round.phase !== "placement" || round.activeTeamId !== teamId) {
      throw new GameError("Only the active team can place this card", "not_active_team");
    }
    round.placement = slot;
  }
  touch(state, context.now);
}

function lockPlacement(state: GameState, teamId: string, context: ActionContext): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  if (round.phase !== "placement" || round.activeTeamId !== teamId) {
    throw new GameError("Only the active team can lock this placement", "not_active_team");
  }
  if (round.placement === null) throw new GameError("Choose a position before locking", "placement_required");
  round.phase = "challenge";
  round.challengeDeadlineAt = state.settings.challengeTimerSeconds === 0
    ? null
    : context.now + state.settings.challengeTimerSeconds * 1000;
  touch(state, context.now);
}

function contest(state: GameState, teamId: string, context: ActionContext): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  requireChallengeRival(state, round, teamId);
  if (round.challengeTeamId !== null) throw new GameError("Another team already claimed this contest", "challenge_claimed", 409);
  if (round.challengePassTeamIds.includes(teamId)) throw new GameError("Your team already chose no contest", "challenge_passed");
  const team = findTeam(state, teamId);
  spendTokens(team, 1);
  round.challengeTeamId = teamId;
  touch(state, context.now);
}

function passChallenge(
  state: GameState,
  teamId: string,
  songs: ReadonlyMap<string, Song>,
  context: ActionContext,
): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  requireChallengeRival(state, round, teamId);
  if (round.challengeTeamId !== null) throw new GameError("The contest has already been claimed", "challenge_claimed");
  if (round.challengePassTeamIds.includes(teamId)) throw new GameError("Your team already chose no contest", "challenge_passed");
  round.challengePassTeamIds.push(teamId);
  const rivals = state.teams.filter((team) => team.id !== round.activeTeamId).map((team) => team.id);
  if (rivals.every((id) => round.challengePassTeamIds.includes(id))) revealRound(state, songs);
  touch(state, context.now);
}

function lockChallenge(
  state: GameState,
  teamId: string,
  songs: ReadonlyMap<string, Song>,
  context: ActionContext,
): void {
  requireOwnTeam(context, teamId);
  const round = requireRound(state);
  if (round.phase !== "challenge" || round.challengeTeamId !== teamId) {
    throw new GameError("Only the contesting team can lock this position", "not_challenger");
  }
  if (round.challengePlacement === null) throw new GameError("Choose a contest position first", "challenge_placement_required");
  revealRound(state, songs);
  touch(state, context.now);
}

function forceReveal(state: GameState, songs: ReadonlyMap<string, Song>, context: ActionContext): void {
  requireController(context);
  const round = requireRound(state);
  if (round.phase !== "challenge") throw new GameError("The round is not waiting on rivals", "not_reveal_ready");
  cancelIncompleteChallenge(state, round);
  revealRound(state, songs);
  touch(state, context.now);
}

function resolveTimer(state: GameState, songs: ReadonlyMap<string, Song>, context: ActionContext): void {
  if (context.actor.role !== "admin") throw new GameError("Only the room timer can resolve this round", "admin_only", 403);
  const round = requireRound(state);
  if (round.phase !== "challenge" || round.challengeDeadlineAt === null || context.now < round.challengeDeadlineAt) return;
  cancelIncompleteChallenge(state, round);
  revealRound(state, songs);
  touch(state, context.now);
}

function cancelIncompleteChallenge(state: GameState, round: GameRound): void {
  if (round.challengeTeamId !== null && round.challengePlacement === null) {
    const challenger = findTeam(state, round.challengeTeamId);
    challenger.tokens = Math.min(MAX_TOKENS, challenger.tokens + 1);
    round.challengeTeamId = null;
  }
}

function awardBonus(state: GameState, context: ActionContext): void {
  requireController(context);
  if (!state.settings.titleArtistBonus) throw new GameError("The title and artist bonus is disabled", "bonus_disabled");
  const round = requireRound(state);
  if (round.phase === "turn_start") throw new GameError("Start the song before awarding the bonus", "bonus_window_closed");
  if (round.bonusAwarded) throw new GameError("This round's bonus was already awarded", "bonus_already_awarded");
  const activeTeam = findTeam(state, round.activeTeamId);
  activeTeam.tokens = Math.min(MAX_TOKENS, activeTeam.tokens + 1);
  round.bonusAwarded = true;
  touch(state, context.now);
}

function nextRound(state: GameState, context: ActionContext): void {
  requireController(context);
  const round = requireRound(state);
  if (round.phase !== "revealed") throw new GameError("Reveal the current card first", "round_not_revealed");
  state.activeTeamIndex = (state.activeTeamIndex + 1) % state.teams.length;
  beginRound(state, round.number + 1);
  touch(state, context.now);
}

function removeTeam(
  state: GameState,
  teamId: string,
  songs: ReadonlyMap<string, Song>,
  context: ActionContext,
): void {
  requireController(context);
  const index = state.teams.findIndex((team) => team.id === teamId);
  if (index < 0) throw new GameError("Team not found", "team_not_found", 404);
  const round = state.currentRound;
  if (round?.challengeTeamId === teamId) {
    const challenger = state.teams[index];
    if (challenger) challenger.tokens = Math.min(MAX_TOKENS, challenger.tokens + 1);
    round.challengeTeamId = null;
    round.challengePlacement = null;
  }
  const removedActive = round?.activeTeamId === teamId;
  state.teams.splice(index, 1);
  if (state.teams.length < 2 && state.status === "playing") {
    finish(state, state.teams[0]?.id ?? null, "last_team");
  } else if (state.status === "playing" && round) {
    state.activeTeamIndex = Math.min(state.activeTeamIndex, state.teams.length - 1);
    if (removedActive) {
      state.discardedSongIds.push(round.songId);
      state.activeTeamIndex = index % state.teams.length;
      beginRound(state, round.number + 1);
    } else if (round.phase === "challenge" && round.challengeTeamId === null) {
      const rivals = state.teams.filter((team) => team.id !== round.activeTeamId).map((team) => team.id);
      if (rivals.every((id) => round.challengePassTeamIds.includes(id))) revealRound(state, songs);
    }
  }
  touch(state, context.now);
}

function rematch(state: GameState, songs: ReadonlyMap<string, Song>, context: ActionContext): void {
  requireController(context);
  if (state.status !== "finished") throw new GameError("Finish this game before starting a rematch", "game_not_finished");
  state.status = "lobby";
  state.winnerTeamId = null;
  state.finishReason = null;
  state.currentRound = null;
  state.activeTeamIndex = 0;
  state.discardedSongIds = [];
  state.deckSongIds = shuffle([...songs.keys()], context.randomIndex);
  for (const team of state.teams) {
    team.ready = false;
    team.tokens = state.settings.startingTokens;
    team.timeline = [];
  }
  touch(state, context.now);
}

function beginRound(state: GameState, number: number): void {
  const activeTeam = state.teams[state.activeTeamIndex];
  if (!activeTeam) throw new GameError("The active team is no longer available", "team_not_found");
  state.currentRound = {
    number,
    activeTeamId: activeTeam.id,
    songId: drawSong(state),
    phase: "turn_start",
    purchaseUsed: false,
    playbackStartedAt: null,
    placement: null,
    challengeTeamId: null,
    challengePlacement: null,
    challengePassTeamIds: [],
    challengeDeadlineAt: null,
    revealTimelineSongIds: null,
    correctPlacement: null,
    outcome: null,
    winnerTeamId: null,
    bonusAwarded: false,
  };
}

function revealRound(state: GameState, songs: ReadonlyMap<string, Song>): void {
  const round = requireRound(state);
  const song = requireSong(songs, round.songId);
  const activeTeam = findTeam(state, round.activeTeamId);
  round.revealTimelineSongIds = [...activeTeam.timeline];
  const activeCorrect = slotAcceptsYear(activeTeam.timeline, round.placement, song.year, songs);
  const challengeCorrect = round.challengeTeamId !== null
    && slotAcceptsYear(activeTeam.timeline, round.challengePlacement, song.year, songs);
  if (activeCorrect) {
    round.correctPlacement = round.placement;
    round.outcome = "active_won";
    round.winnerTeamId = activeTeam.id;
    insertSong(activeTeam, song.id, songs);
  } else if (challengeCorrect && round.challengeTeamId !== null) {
    round.correctPlacement = round.challengePlacement;
    round.outcome = "challenge_won";
    round.winnerTeamId = round.challengeTeamId;
    insertSong(findTeam(state, round.challengeTeamId), song.id, songs);
  } else {
    round.correctPlacement = canonicalSlot(activeTeam.timeline, song, songs);
    round.outcome = "no_winner";
    state.discardedSongIds.push(song.id);
  }
  round.phase = "revealed";
  round.challengeDeadlineAt = null;
  const winner = state.teams.find((team) => team.timeline.length >= state.settings.targetCards);
  if (winner) finish(state, winner.id, "target_reached");
  else if (state.deckSongIds.length === 0) finish(state, null, "deck_empty");
}

function finish(state: GameState, winnerTeamId: string | null, reason: string): void {
  state.status = "finished";
  state.winnerTeamId = winnerTeamId;
  state.finishReason = reason;
}

function requireStatus(state: GameState, expected: GameState["status"]): void {
  if (state.status !== expected) throw new GameError(`The room is not ${expected}`, "invalid_room_status");
}

function requireRound(state: GameState): GameRound {
  if (state.status !== "playing" || state.currentRound === null) {
    throw new GameError("The game has not started", "game_not_started");
  }
  return state.currentRound;
}

function requireHost(context: ActionContext): void {
  if (context.actor.role !== "host") throw new GameError("Only the playback host can do that", "host_only", 403);
}

function requireController(context: ActionContext): void {
  if (!["host", "controller", "admin"].includes(context.actor.role)) {
    throw new GameError("Only a host controller can do that", "host_only", 403);
  }
}

function requireOwnTeam(context: ActionContext, teamId: string): void {
  if (context.actor.role !== "team" || context.actor.teamId !== teamId) {
    throw new GameError("Only that team can do this", "team_only", 403);
  }
}

function requireChallengeRival(state: GameState, round: GameRound, teamId: string): void {
  if (round.phase !== "challenge") throw new GameError("The contest window is not open", "challenge_closed");
  if (round.activeTeamId === teamId) throw new GameError("The active team cannot contest itself", "active_team_challenge");
  findTeam(state, teamId);
}

function findTeam(state: GameState, teamId: string): Team {
  const team = state.teams.find((candidate) => candidate.id === teamId);
  if (!team) throw new GameError("Team not found", "team_not_found", 404);
  return team;
}

function spendTokens(team: Team, amount: number): void {
  if (team.tokens < amount) throw new GameError(`You need ${amount} token${amount === 1 ? "" : "s"}`, "not_enough_tokens");
  team.tokens -= amount;
}

function drawSong(state: GameState): string {
  const songId = state.deckSongIds.pop();
  if (!songId) throw new GameError("The song deck is empty", "deck_empty");
  return songId;
}

function insertSong(team: Team, songId: string, songs: ReadonlyMap<string, Song>): void {
  team.timeline.push(songId);
  team.timeline.sort((leftId, rightId) => {
    const left = requireSong(songs, leftId);
    const right = requireSong(songs, rightId);
    return left.year - right.year || left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  });
}

function requireSong(songs: ReadonlyMap<string, Song>, songId: string): Song {
  const song = songs.get(songId);
  if (!song) throw new GameError("The room references an unavailable song", "song_not_found", 500);
  return song;
}

export function slotAcceptsYear(
  timeline: string[],
  slot: number | null,
  year: number,
  songs: ReadonlyMap<string, Song>,
): boolean {
  if (slot === null || slot < 0 || slot > timeline.length) return false;
  const lowerId = slot > 0 ? timeline[slot - 1] : undefined;
  const upperId = slot < timeline.length ? timeline[slot] : undefined;
  const lower = lowerId === undefined ? null : requireSong(songs, lowerId).year;
  const upper = upperId === undefined ? null : requireSong(songs, upperId).year;
  return (lower === null || lower <= year) && (upper === null || year <= upper);
}

function canonicalSlot(timeline: string[], song: Song, songs: ReadonlyMap<string, Song>): number {
  return timeline.reduce((slot, songId) => {
    const existing = requireSong(songs, songId);
    return slot + (existing.year < song.year || (existing.year === song.year && existing.title.localeCompare(song.title) <= 0) ? 1 : 0);
  }, 0);
}

function shuffle<T>(items: T[], randomIndex: (upperExclusive: number) => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (!Number.isInteger(swapIndex) || swapIndex < 0 || swapIndex > index) {
      throw new GameError("Random source returned an invalid index", "invalid_random_source", 500);
    }
    const value = items[index];
    items[index] = items[swapIndex] as T;
    items[swapIndex] = value as T;
  }
  return items;
}

function touch(state: GameState, now: number): void {
  state.revision += 1;
  state.lastActivityAt = now;
  state.expiresAt = now + ROOM_INACTIVITY_MS;
}
