import { describe, expect, it } from "vitest";
import {
  addTeam,
  applyGameAction,
  createGameState,
  DEFAULT_SETTINGS,
  MAX_TOKENS,
  ROOM_INACTIVITY_MS,
  slotAcceptsYear,
  validateSettings,
} from "../src/domain/game";
import { GameError } from "../src/domain/errors";
import type { ActionContext, Deck, GameState, Song } from "../src/domain/types";

const NOW = 1_800_000_000_000;
const years = [1980, 1990, 2000, 2010, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027];
const songs = new Map<string, Song>(
  years.map((year) => [
    `song-${year}`,
    {
      id: `song-${year}`,
      title: `Song ${year}`,
      artist: `Artist ${year}`,
      year,
      spotifyUrl: `https://open.spotify.com/track/song${year}`,
      spotifyUri: `spotify:track:song${year}`,
    },
  ]),
);
const deck: Deck = {
  id: "millennial-anthems",
  name: "Millennial Anthems",
  songs: [...songs.values()],
};

function indexZero(): number {
  return 0;
}

function actor(
  value: ActionContext["actor"],
  now = NOW,
): ActionContext {
  return { actor: value, now, randomIndex: indexZero };
}

function lobby(settings = {}): GameState {
  const state = createGameState("TEST", "host-hash", settings, deck, NOW, indexZero);
  addTeam(state, { id: "alpha", name: "Alpha", tokenHash: "a", joinedAt: NOW }, NOW);
  addTeam(state, { id: "bravo", name: "Bravo", tokenHash: "b", joinedAt: NOW }, NOW);
  return state;
}

function readyAndStart(state: GameState): void {
  applyGameAction(state, { type: "set_ready", teamId: "alpha", ready: true }, songs, actor({ role: "team", teamId: "alpha" }));
  applyGameAction(state, { type: "set_ready", teamId: "bravo", ready: true }, songs, actor({ role: "team", teamId: "bravo" }));
  applyGameAction(state, { type: "start_game" }, songs, actor({ role: "host" }));
}

function startPlacement(state: GameState): void {
  applyGameAction(state, { type: "mark_playback_started" }, songs, actor({ role: "host" }));
}

function correctSlot(state: GameState): number {
  const round = state.currentRound;
  if (!round) throw new Error("missing round");
  const team = state.teams.find((candidate) => candidate.id === round.activeTeamId);
  const song = songs.get(round.songId);
  if (!team || !song) throw new Error("missing test data");
  const slot = Array.from({ length: team.timeline.length + 1 }, (_, index) => index)
    .find((index) => slotAcceptsYear(team.timeline, index, song.year, songs));
  if (slot === undefined) throw new Error("missing correct slot");
  return slot;
}

function lockActivePlacement(state: GameState, slot = correctSlot(state)): void {
  const activeTeamId = state.currentRound?.activeTeamId;
  if (!activeTeamId) throw new Error("missing active team");
  const teamActor = actor({ role: "team", teamId: activeTeamId });
  applyGameAction(state, { type: "place", teamId: activeTeamId, slot }, songs, teamActor);
  applyGameAction(state, { type: "lock_placement", teamId: activeTeamId }, songs, teamActor);
}

describe("room settings and lobby", () => {
  it("applies the agreed defaults and bounds", () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(() => validateSettings({ startingTokens: 6 })).toThrow(GameError);
    expect(() => validateSettings({ targetCards: 1 })).toThrow(GameError);
    expect(() => validateSettings({ challengeTimerSeconds: 15 as 30 })).toThrow(GameError);
    expect(() => validateSettings({ deckId: "uploaded" })).toThrow(GameError);
  });

  it("normalizes names, rejects duplicates, and caps teams", () => {
    const state = createGameState("TEST", "host", {}, deck, NOW, indexZero);
    addTeam(state, { id: "1", name: "  The   Crew ", tokenHash: "1", joinedAt: NOW }, NOW);
    expect(state.teams[0]?.name).toBe("The Crew");
    expect(() => addTeam(state, { id: "2", name: "the crew", tokenHash: "2", joinedAt: NOW }, NOW))
      .toThrowError(/already in use/);
    for (let index = 2; index <= 8; index += 1) {
      addTeam(state, { id: String(index), name: `Team ${index}`, tokenHash: String(index), joinedAt: NOW }, NOW);
    }
    expect(() => addTeam(state, { id: "9", name: "Team 9", tokenHash: "9", joinedAt: NOW }, NOW))
      .toThrowError(/8 teams/);
  });

  it("requires every joined team to be ready", () => {
    const state = lobby();
    applyGameAction(state, { type: "set_ready", teamId: "alpha", ready: true }, songs, actor({ role: "team", teamId: "alpha" }));
    expect(() => applyGameAction(state, { type: "start_game" }, songs, actor({ role: "host" })))
      .toThrowError(/Every team/);
    applyGameAction(state, { type: "set_ready", teamId: "bravo", ready: true }, songs, actor({ role: "team", teamId: "bravo" }));
    applyGameAction(state, { type: "start_game" }, songs, actor({ role: "controller", teamId: "alpha" }));
    expect(state.status).toBe("playing");
    expect(state.teams.every((team) => team.timeline.length === 1)).toBe(true);
    expect(state.currentRound?.phase).toBe("turn_start");
  });
});

describe("turn economy and playback", () => {
  it("allows one active-team purchase only before playback", () => {
    const state = lobby({ startingTokens: 5 });
    readyAndStart(state);
    const active = state.currentRound?.activeTeamId ?? "";
    applyGameAction(state, { type: "buy_random_card", teamId: active }, songs, actor({ role: "team", teamId: active }));
    expect(state.teams.find((team) => team.id === active)?.tokens).toBe(2);
    expect(() => applyGameAction(state, { type: "buy_random_card", teamId: active }, songs, actor({ role: "team", teamId: active })))
      .toThrowError(/Only one/);
    startPlacement(state);
    expect(() => applyGameAction(state, { type: "buy_random_card", teamId: active }, songs, actor({ role: "team", teamId: active })))
      .toThrowError(/start of your turn/);
  });

  it("restricts playback start to the original host", () => {
    const state = lobby();
    readyAndStart(state);
    expect(() => applyGameAction(
      state,
      { type: "mark_playback_started" },
      songs,
      actor({ role: "controller", teamId: "alpha" }),
    )).toThrowError(/playback host/);
    startPlacement(state);
    expect(state.currentRound?.phase).toBe("placement");
  });

  it("charges for repeat replacements and returns to manual playback", () => {
    const state = lobby({ startingTokens: 3 });
    readyAndStart(state);
    startPlacement(state);
    const active = state.currentRound?.activeTeamId ?? "";
    const firstSong = state.currentRound?.songId;
    applyGameAction(state, { type: "replace_song", teamId: active }, songs, actor({ role: "team", teamId: active }));
    expect(state.currentRound?.phase).toBe("turn_start");
    expect(state.currentRound?.songId).not.toBe(firstSong);
    expect(state.discardedSongIds).toContain(firstSong);
    expect(state.teams.find((team) => team.id === active)?.tokens).toBe(2);
    startPlacement(state);
    applyGameAction(state, { type: "replace_song", teamId: active }, songs, actor({ role: "team", teamId: active }));
    expect(state.teams.find((team) => team.id === active)?.tokens).toBe(1);
  });

  it("clamps a once-per-round title and artist bonus at five", () => {
    const state = lobby({ startingTokens: 5 });
    readyAndStart(state);
    startPlacement(state);
    applyGameAction(state, { type: "award_title_artist_bonus" }, songs, actor({ role: "controller", teamId: "bravo" }));
    const active = state.currentRound?.activeTeamId;
    expect(state.teams.find((team) => team.id === active)?.tokens).toBe(MAX_TOKENS);
    expect(() => applyGameAction(state, { type: "award_title_artist_bonus" }, songs, actor({ role: "host" })))
      .toThrowError(/already awarded/);
  });
});

describe("placement, contest, and reveal", () => {
  it("auto-reveals when every rival passes", () => {
    const state = lobby();
    readyAndStart(state);
    startPlacement(state);
    lockActivePlacement(state);
    const active = state.currentRound?.activeTeamId;
    const rival = state.teams.find((team) => team.id !== active)?.id ?? "";
    applyGameAction(state, { type: "pass_challenge", teamId: rival }, songs, actor({ role: "team", teamId: rival }));
    expect(state.currentRound?.phase).toBe("revealed");
    expect(state.currentRound?.outcome).toBe("active_won");
  });

  it("charges only the first contesting rival and auto-reveals on lock", () => {
    const state = lobby();
    addTeam(state, { id: "charlie", name: "Charlie", tokenHash: "c", joinedAt: NOW }, NOW);
    for (const id of ["alpha", "bravo", "charlie"]) {
      applyGameAction(state, { type: "set_ready", teamId: id, ready: true }, songs, actor({ role: "team", teamId: id }));
    }
    applyGameAction(state, { type: "start_game" }, songs, actor({ role: "host" }));
    startPlacement(state);
    const right = correctSlot(state);
    const wrong = right === 0 ? 1 : 0;
    lockActivePlacement(state, wrong);
    const active = state.currentRound?.activeTeamId;
    const [challenger, late] = state.teams.filter((team) => team.id !== active);
    if (!challenger || !late) throw new Error("missing rivals");
    applyGameAction(state, { type: "contest", teamId: challenger.id }, songs, actor({ role: "team", teamId: challenger.id }));
    let lateError: unknown;
    try {
      applyGameAction(state, { type: "contest", teamId: late.id }, songs, actor({ role: "team", teamId: late.id }));
    } catch (error) {
      lateError = error;
    }
    expect(lateError).toMatchObject({ code: "challenge_claimed", status: 409 });
    applyGameAction(state, { type: "place_challenge", teamId: challenger.id, slot: right }, songs, actor({ role: "team", teamId: challenger.id }));
    applyGameAction(state, { type: "lock_challenge", teamId: challenger.id }, songs, actor({ role: "team", teamId: challenger.id }));
    expect(state.currentRound?.phase).toBe("revealed");
    expect(state.currentRound?.outcome).toBe("challenge_won");
    expect(state.currentRound?.winnerTeamId).toBe(challenger.id);
  });

  it("lets a controller force reveal and refunds an unfinished contest", () => {
    const state = lobby();
    readyAndStart(state);
    startPlacement(state);
    lockActivePlacement(state);
    const active = state.currentRound?.activeTeamId;
    const rival = state.teams.find((team) => team.id !== active);
    if (!rival) throw new Error("missing rival");
    const before = rival.tokens;
    applyGameAction(state, { type: "contest", teamId: rival.id }, songs, actor({ role: "team", teamId: rival.id }));
    applyGameAction(state, { type: "force_reveal" }, songs, actor({ role: "controller", teamId: rival.id }));
    expect(rival.tokens).toBe(before);
    expect(state.currentRound?.challengeTeamId).toBeNull();
    expect(state.currentRound?.phase).toBe("revealed");
  });

  it("uses the timer deadline and does not treat reads as activity", () => {
    const state = lobby({ challengeTimerSeconds: 30 });
    readyAndStart(state);
    startPlacement(state);
    lockActivePlacement(state);
    const deadline = state.currentRound?.challengeDeadlineAt;
    expect(deadline).toBe(NOW + 30_000);
    applyGameAction(state, { type: "resolve_timer" }, songs, actor({ role: "admin" }, NOW + 29_999));
    expect(state.currentRound?.phase).toBe("challenge");
    applyGameAction(state, { type: "resolve_timer" }, songs, actor({ role: "admin" }, NOW + 30_000));
    expect(state.currentRound?.phase).toBe("revealed");
    expect(state.expiresAt).toBe(NOW + 30_000 + ROOM_INACTIVITY_MS);
  });
});

describe("roster, finish, and rematch", () => {
  it("discards the song and advances when the active team is removed", () => {
    const state = lobby();
    addTeam(state, { id: "charlie", name: "Charlie", tokenHash: "c", joinedAt: NOW }, NOW);
    for (const id of ["alpha", "bravo", "charlie"]) {
      applyGameAction(state, { type: "set_ready", teamId: id, ready: true }, songs, actor({ role: "team", teamId: id }));
    }
    applyGameAction(state, { type: "start_game" }, songs, actor({ role: "host" }));
    const active = state.currentRound?.activeTeamId ?? "";
    const songId = state.currentRound?.songId;
    applyGameAction(state, { type: "remove_team", teamId: active }, songs, actor({ role: "controller", teamId: "bravo" }));
    expect(state.teams.some((team) => team.id === active)).toBe(false);
    expect(state.discardedSongIds).toContain(songId);
    expect(state.currentRound?.number).toBe(2);
  });

  it("finishes when only one team remains", () => {
    const state = lobby();
    readyAndStart(state);
    applyGameAction(state, { type: "remove_team", teamId: "bravo" }, songs, actor({ role: "host" }));
    expect(state.status).toBe("finished");
    expect(state.winnerTeamId).toBe("alpha");
    expect(state.finishReason).toBe("last_team");
  });

  it("resets the same roster and settings for a rematch", () => {
    const state = lobby({ targetCards: 2 });
    readyAndStart(state);
    startPlacement(state);
    lockActivePlacement(state);
    const rival = state.teams.find((team) => team.id !== state.currentRound?.activeTeamId);
    if (!rival) throw new Error("missing rival");
    applyGameAction(state, { type: "pass_challenge", teamId: rival.id }, songs, actor({ role: "team", teamId: rival.id }));
    expect(state.status).toBe("finished");
    applyGameAction(state, { type: "rematch" }, songs, actor({ role: "controller", teamId: rival.id }));
    expect(state.status).toBe("lobby");
    expect(state.teams).toHaveLength(2);
    expect(state.teams.every((team) => !team.ready && team.timeline.length === 0 && team.tokens === 2)).toBe(true);
    expect(state.currentRound).toBeNull();
    expect(state.settings.targetCards).toBe(2);
  });
});
