import type { RoomSnapshot } from "./contracts";
import type { GameState, Song } from "./domain/types";

export interface Viewer {
  role: "host" | "controller" | "team";
  teamId: string | null;
  playbackOwner: boolean;
}

export function serializeRoom(
  state: GameState,
  songs: ReadonlyMap<string, Song>,
  viewer: Viewer,
): RoomSnapshot {
  const round = state.currentRound;
  const activeTeam = round ? state.teams.find((team) => team.id === round.activeTeamId) : undefined;
  const viewerTeam = viewer.teamId ? state.teams.find((team) => team.id === viewer.teamId) : undefined;
  const activeTimelineIds = round?.phase === "revealed" && round.revealTimelineSongIds
    ? round.revealTimelineSongIds
    : activeTeam?.timeline ?? [];

  const snapshot: RoomSnapshot = {
    room: {
      code: state.roomCode,
      status: state.status,
      revision: state.revision,
      settings: state.settings,
      expiresAt: state.expiresAt,
      winnerTeamId: state.winnerTeamId,
      finishReason: state.finishReason,
    },
    viewer,
    teams: state.teams.map((team) => ({
      id: team.id,
      name: team.name,
      ready: team.ready,
      tokens: team.tokens,
      cardCount: team.timeline.length,
      isActive: team.id === round?.activeTeamId,
    })),
    round: null,
    activeTimeline: publicSongs(activeTimelineIds, songs),
    viewerTimeline: publicSongs(viewerTeam?.timeline ?? [], songs),
    can: {},
  };

  if (!round) {
    snapshot.can = {
      setReady: viewer.role === "team",
      startGame: isController(viewer) && state.teams.length >= 2 && state.teams.every((team) => team.ready),
      removeTeam: isController(viewer),
    };
    return snapshot;
  }

  const viewerIsActive = viewer.teamId === round.activeTeamId && viewer.role === "team";
  const viewerIsChallenger = viewer.teamId === round.challengeTeamId && viewer.role === "team";
  const terminal = state.status !== "playing";
  const song = requireSong(songs, round.songId);
  const showActivePlacement = isController(viewer) || viewer.teamId === round.activeTeamId || round.phase === "challenge" || round.phase === "revealed";
  const showChallengePlacement = isController(viewer) || viewerIsChallenger || round.phase === "revealed";

  snapshot.round = {
    number: round.number,
    phase: round.phase,
    activeTeamId: round.activeTeamId,
    playbackStarted: round.playbackStartedAt !== null,
    placement: showActivePlacement ? round.placement : null,
    challengeTeamId: round.challengeTeamId,
    challengePlacement: showChallengePlacement ? round.challengePlacement : null,
    challengePassCount: round.challengePassTeamIds.length,
    challengePassTotal: Math.max(0, state.teams.length - 1),
    viewerPassed: viewer.teamId !== null && round.challengePassTeamIds.includes(viewer.teamId),
    challengeDeadlineAt: round.challengeDeadlineAt,
    correctPlacement: round.correctPlacement,
    outcome: round.outcome,
    winnerTeamId: round.winnerTeamId,
    bonusAwarded: round.bonusAwarded,
    song: round.phase === "revealed"
      ? publicSong(song)
      : viewer.playbackOwner
        ? { id: song.id, spotifyUri: song.spotifyUri, spotifyUrl: song.spotifyUrl }
        : { id: "mystery" },
  };

  if (terminal) {
    snapshot.can = {
      rematch: state.status === "finished" && isController(viewer),
    };
    return snapshot;
  }

  const viewerTokens = viewerTeam?.tokens ?? 0;
  const viewerPassed = viewer.teamId !== null && round.challengePassTeamIds.includes(viewer.teamId);
  snapshot.can = {
    buyRandomCard: viewerIsActive && round.phase === "turn_start" && !round.purchaseUsed && viewerTokens >= 3,
    markPlaybackStarted: viewer.playbackOwner && round.phase === "turn_start",
    replaceSong: viewerIsActive && round.phase === "placement" && round.playbackStartedAt !== null && viewerTokens >= 1,
    place: viewerIsActive && round.phase === "placement",
    lockPlacement: viewerIsActive && round.phase === "placement" && round.placement !== null,
    contest: viewer.role === "team"
      && viewer.teamId !== round.activeTeamId
      && round.phase === "challenge"
      && round.challengeTeamId === null
      && !viewerPassed
      && viewerTokens >= 1,
    passChallenge: viewer.role === "team"
      && viewer.teamId !== round.activeTeamId
      && round.phase === "challenge"
      && round.challengeTeamId === null
      && !viewerPassed,
    placeChallenge: viewerIsChallenger && round.phase === "challenge",
    lockChallenge: viewerIsChallenger && round.phase === "challenge" && round.challengePlacement !== null,
    forceReveal: isController(viewer) && round.phase === "challenge",
    awardTitleArtistBonus: isController(viewer)
      && state.settings.titleArtistBonus
      && round.phase !== "turn_start"
      && !round.bonusAwarded,
    nextRound: isController(viewer) && round.phase === "revealed",
    removeTeam: isController(viewer),
  };
  return snapshot;
}

function isController(viewer: Viewer): boolean {
  return viewer.role === "host" || viewer.role === "controller";
}

function publicSongs(ids: string[], songs: ReadonlyMap<string, Song>): ReturnType<typeof publicSong>[] {
  return ids.map((id) => publicSong(requireSong(songs, id)));
}

function publicSong(song: Song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    year: song.year,
    spotifyUrl: song.spotifyUrl,
    spotifyUri: song.spotifyUri,
  };
}

function requireSong(songs: ReadonlyMap<string, Song>, id: string): Song {
  const song = songs.get(id);
  if (!song) throw new Error(`Song ${id} is unavailable`);
  return song;
}
