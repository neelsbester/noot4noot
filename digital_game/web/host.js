import {
  api,
  controllerModeFromUrl,
  copyText,
  createRoomUpdates,
  createToast,
  formatTimer,
  performAction,
  renderTimeline,
  renderRevealCard,
  renderTurnTeam,
  revealPlacement,
  roomRoleUrl,
  roomFromUrl,
  seatFromUrl,
  snapshotMotion,
  teamById,
} from "./shared.js";
import {
  beginSpotifyLogin,
  clearSpotifySession,
  configureSpotify,
  getSpotifyDevices,
  getSpotifyToken,
  handleSpotifyCallback,
  loadSpotifyDevice,
  pauseSpotifyPlayback,
  playSpotifyTrack,
  saveSpotifyDevice,
} from "./spotify.js";
import { createBrowserSpotifyPlayer } from "./spotify-browser-player.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const toast = createToast(elements.toast);
let room = roomFromUrl();
const controllerMode = controllerModeFromUrl();
const labModeRequested = new URLSearchParams(window.location.search).get("lab") === "1"
  && seatFromUrl() === "lab-host";
let state = null;
let stopUpdates = null;
let timerHandle = null;
let spotifyPlayer = null;
let browserDeviceId = "";
let spotifyConnected = false;
let labPlayback = false;
let playbackBusy = false;
let highestSeenRevision = -1;
let activeMotion = null;

function setSection(name) {
  for (const section of ["loading", "lobby", "game", "finished"]) {
    elements[section].hidden = section !== name;
  }
}

function currentDevice() {
  return elements["spotify-device"].value || "";
}

async function act(action) {
  if (!state) return;
  try {
    const next = await performAction(room, state, action, controllerMode);
    await acceptSnapshot(next);
    return true;
  } catch (error) {
    await refresh();
    if (error.code === "stale_state" && action.type === "start_game" && state?.can.startGame) {
      try {
        const next = await performAction(room, state, action, controllerMode);
        await acceptSnapshot(next);
        return true;
      } catch (retryError) {
        toast(retryError.message);
        return false;
      }
    }
    toast(error.message);
    return false;
  }
}

function makeTeamRow(team, removable = false) {
  const row = document.createElement("div");
  row.className = `team-row${team.isActive ? " is-active" : ""}`;
  const initial = document.createElement("span");
  initial.className = "team-initial";
  initial.textContent = team.name.slice(0, 1).toUpperCase();
  const main = document.createElement("div");
  main.className = "team-row-main";
  const name = document.createElement("strong");
  name.textContent = team.name;
  const detail = document.createElement("small");
  if (state.room.status === "lobby") {
    detail.textContent = team.ready ? "Ready to play" : "Not ready yet";
  } else {
    detail.append(`${team.cardCount} / ${state.room.settings.targetCards} cards · `);
    const tokenCount = document.createElement("span");
    tokenCount.className = "team-token-counter";
    tokenCount.textContent = `${team.tokens} tokens`;
    const tokenDelta = activeMotion?.tokenDeltas[team.id] ?? 0;
    tokenCount.classList.toggle("motion-token-ring", tokenDelta !== 0);
    tokenCount.dataset.tokenDelta = tokenDelta > 0 ? `+${tokenDelta}` : String(tokenDelta);
    detail.append(tokenCount);
  }
  main.append(name, detail);
  row.append(initial, main);
  if (state.room.status === "lobby") {
    const ready = document.createElement("span");
    ready.className = team.ready ? "ready" : "ready not-ready";
    ready.textContent = team.ready ? "READY" : "WAITING";
    row.append(ready);
  }
  if (removable && state.can.removeTeam) {
    const remove = document.createElement("button");
    remove.className = "button compact danger";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (window.confirm(`Remove ${team.name} from this game?`)) {
        void act({ type: "remove_team", teamId: team.id });
      }
    });
    row.append(remove);
  }
  return row;
}

function renderTeamList(container, removable) {
  container.replaceChildren(...state.teams.map((team) => makeTeamRow(team, removable)));
}

function renderLobby() {
  setSection("lobby");
  elements["room-code"].textContent = room;
  elements["team-count"].textContent = `${state.teams.length} / 2 minimum`;
  const joinUrl = `${window.location.origin}/?room=${encodeURIComponent(room)}`;
  elements["join-url"].textContent = joinUrl;
  renderTeamList(elements["lobby-teams"], true);
  elements["start-game"].disabled = !state.can.startGame;
  elements["start-game"].textContent = "Start game";
  elements["lobby-help"].textContent = state.teams.length < 2
    ? "At least two teams must join."
    : state.teams.every((team) => team.ready)
      ? "Everyone is ready. Start when the room is settled."
      : "Waiting for every team to mark themselves ready.";
}

function roundCopy(round, active, challenger) {
  if (round.phase === "turn_start") return ["Ready when you are.", "The active team can buy a card before you start this song."];
  if (round.phase === "placement") return [`${active?.name || "The active team"} is placing.`, "Keep the song playing while they choose a position."];
  if (round.phase === "challenge" && challenger) return [`${challenger.name} is contesting.`, "They must select and lock a different position."];
  if (round.phase === "challenge") return ["Contest window open.", "Rival teams may contest or pass. You can force the reveal at any time."];
  if (round.outcome === "active_won") return [`${active?.name || "The active team"} placed it.`, "The card joins their timeline."];
  if (round.outcome === "challenge_won") return [`${challenger?.name || "The challenger"} stole it.`, "Their contest position was correct."];
  return ["No card this round.", "Neither locked position was correct."];
}

function renderGame() {
  setSection("game");
  const round = state.round;
  const active = teamById(state, round.activeTeamId);
  const challenger = teamById(state, round.challengeTeamId);
  const revealed = round.phase === "revealed";
  const [title, copy] = roundCopy(round, active, challenger);
  elements["round-number"].textContent = String(round.number);
  const previousActive = teamById(state, activeMotion?.previousActiveTeamId);
  renderTurnTeam(
    elements["active-team"],
    active?.name || "—",
    previousActive?.name,
    Boolean(activeMotion?.turnChange),
  );
  elements.phase.textContent = round.phase.replaceAll("_", " ");
  elements["stage-title"].textContent = title;
  elements["stage-copy"].textContent = copy;
  elements["timeline-team"].textContent = active?.name || "—";
  elements.record.classList.toggle("revealed", revealed);
  elements["song-meta"].hidden = !revealed;
  if (revealed) {
    elements["song-title"].textContent = round.song.title;
    elements["song-artist"].textContent = round.song.artist;
    elements["song-year"].textContent = String(round.song.year);
  }
  const reveal = revealPlacement(round);
  renderTimeline(elements.timeline, state.activeTimeline, {
    placement: round.placement,
    challengePlacement: round.challengePlacement,
    ...reveal,
  });
  const winner = teamById(state, round.winnerTeamId);
  renderRevealCard(
    elements["round-reveal-card"],
    round,
    winner?.name || "",
    Boolean(activeMotion?.reveal),
    Boolean(activeMotion?.earnedCard),
  );
  elements["round-help"].textContent = copy;
  elements["force-reveal"].hidden = !state.can.forceReveal;
  elements["award-bonus"].hidden = !state.can.awardTitleArtistBonus;
  elements["next-round"].hidden = !state.can.nextRound;
  renderTeamList(elements["game-teams"], true);

  const playbackOwner = state.viewer.playbackOwner;
  elements["spotify-box"].hidden = !playbackOwner;
  elements["controller-note"].hidden = playbackOwner;
  elements["back-to-team"].hidden = state.viewer.role !== "controller";
  const songPlayable = "spotifyUri" in round.song && Boolean(round.song.spotifyUri);
  elements["play-song"].disabled = playbackBusy || !spotifyConnected || !currentDevice() || !songPlayable;
  elements["play-song"].textContent = round.playbackStarted ? "Play again" : "Play this song";
  elements["pause-song"].disabled = playbackBusy || !spotifyConnected || !currentDevice();
  elements["spotify-fallback"].hidden = !playbackOwner || !("spotifyUrl" in round.song) || !round.song.spotifyUrl;
  if (labPlayback) {
    elements["spotify-refresh"].hidden = true;
    elements["pause-song"].hidden = true;
    elements["spotify-fallback"].hidden = true;
  }
  if (!elements["spotify-fallback"].hidden) elements["spotify-fallback"].href = round.song.spotifyUrl;
  updateTimer();
}

function renderFinished() {
  setSection("finished");
  const winner = teamById(state, state.room.winnerTeamId);
  elements["result-title"].textContent = winner ? `${winner.name} wins.` : "Game complete.";
  elements["result-copy"].textContent = winner
    ? `${winner.cardCount} cards completed the winning timeline.`
    : "The final song has been played.";
  const teams = [...state.teams].sort((a, b) => b.cardCount - a.cardCount || b.tokens - a.tokens);
  elements.standings.replaceChildren(...teams.map((team, index) => {
    const row = document.createElement("div");
    row.className = `standing${team.id === state.room.winnerTeamId ? " is-winner" : ""}`;
    const rank = document.createElement("span");
    rank.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("strong");
    name.textContent = team.name;
    const score = document.createElement("small");
    score.textContent = `${team.cardCount} cards · ${team.tokens} tokens`;
    row.append(rank, name, score);
    return row;
  }));
  elements.rematch.hidden = !state.can.rematch;
}

function render() {
  elements["header-room"].textContent = room || "----";
  if (!state) return;
  if (state.room.status === "lobby") renderLobby();
  else if (state.room.status === "playing") renderGame();
  else renderFinished();
}

async function pauseForStateTransition(next) {
  if (labPlayback || !state?.viewer.playbackOwner || !spotifyConnected || !currentDevice()) return;
  const oldRound = state.round;
  const newRound = next.round;
  const changed = oldRound && (
    !newRound
    || oldRound.number !== newRound.number
    || oldRound.song.id !== newRound.song.id
    || (state.room.status === "playing" && next.room.status !== "playing")
  );
  if (changed) {
    try {
      await pauseSpotifyPlayback(currentDevice());
    } catch {
      // The manual pause button remains available if Spotify was already idle.
    }
  }
}

async function refresh() {
  if (!room) return;
  try {
    const query = controllerMode ? "?mode=controller" : "";
    const next = await api(`/api/rooms/${encodeURIComponent(room)}/state${query}`);
    await acceptSnapshot(next);
  } catch (error) {
    toast(error.message);
    if ([401, 404].includes(error.status)) window.setTimeout(() => window.location.assign("/"), 1200);
  }
}

async function acceptSnapshot(next) {
  if (next.room.revision < highestSeenRevision || next.room.revision < (state?.room.revision ?? -1)) {
    return false;
  }
  highestSeenRevision = Math.max(highestSeenRevision, next.room.revision);
  if (state && next.room.revision === state.room.revision) return false;
  await pauseForStateTransition(next);
  if (next.room.revision < highestSeenRevision || next.room.revision < (state?.room.revision ?? -1)) {
    return false;
  }
  activeMotion = snapshotMotion(state, next);
  state = next;
  render();
  activeMotion = null;
  return true;
}

function updateTimer() {
  if (!state?.round?.challengeDeadlineAt || state.round.phase !== "challenge") {
    elements.timer.textContent = "";
    return;
  }
  elements.timer.textContent = `${formatTimer(state.round.challengeDeadlineAt)}s`;
}

async function loadDevices() {
  const devices = await getSpotifyDevices();
  if (browserDeviceId && !devices.some((device) => device.id === browserDeviceId)) {
    devices.unshift({ id: browserDeviceId, name: "This browser", type: "Browser" });
  }
  const saved = loadSpotifyDevice();
  const selected = devices.some((device) => device.id === saved)
    ? saved
    : browserDeviceId || devices[0]?.id || "";
  elements["spotify-device"].replaceChildren(new Option("Choose playback device", ""));
  for (const device of devices) {
    elements["spotify-device"].add(new Option(`${device.name} · ${device.type}`, device.id));
  }
  elements["spotify-device"].value = selected;
  if (selected) saveSpotifyDevice(selected);
  elements["spotify-device-row"].hidden = false;
  spotifyConnected = true;
  elements["spotify-connect"].hidden = true;
  elements["spotify-disconnect"].hidden = false;
  render();
}

async function initializeSpotify() {
  if (!state?.viewer.playbackOwner) return;
  try {
    const config = await configureSpotify();
    if (labModeRequested && ["local", "staging"].includes(config.environment)) {
      labPlayback = true;
      browserDeviceId = "test-lab-silent-player";
      spotifyConnected = true;
      elements["spotify-device"].replaceChildren(new Option("Silent test player · Simulation", browserDeviceId));
      elements["spotify-device"].value = browserDeviceId;
      elements["spotify-device"].disabled = true;
      elements["spotify-device-row"].hidden = false;
      elements["spotify-connect"].hidden = true;
      elements["spotify-disconnect"].hidden = true;
      render();
      return;
    }
    await handleSpotifyCallback();
    const token = await getSpotifyToken();
    if (!token) return;
    loadSpotifySDK();
    spotifyPlayer = await createBrowserSpotifyPlayer({
      getToken: getSpotifyToken,
      onError: (message) => toast(message),
    });
    browserDeviceId = spotifyPlayer.deviceId;
    await spotifyPlayer.activate();
    await loadDevices();
  } catch (error) {
    toast(error.message);
    if (await getSpotifyToken()) {
      try {
        await loadDevices();
      } catch (deviceError) {
        toast(deviceError.message);
      }
    }
  }
}

function loadSpotifySDK() {
  if (document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]')) return;
  const script = document.createElement("script");
  script.src = "https://sdk.scdn.co/spotify-player.js";
  document.head.append(script);
}

elements["copy-join"].addEventListener("click", async () => {
  await copyText(elements["join-url"].textContent);
  toast("Room address copied.");
});
elements["start-game"].addEventListener("click", async () => {
  elements["start-game"].disabled = true;
  elements["start-game"].textContent = "Starting…";
  const started = await act({ type: "start_game" });
  if (!started && state?.room.status === "lobby") renderLobby();
});
elements["force-reveal"].addEventListener("click", () => void act({ type: "force_reveal" }));
elements["award-bonus"].addEventListener("click", () => void act({ type: "award_title_artist_bonus" }));
elements["next-round"].addEventListener("click", () => void act({ type: "next_round" }));
elements.rematch.addEventListener("click", () => void act({ type: "rematch" }));
elements["back-to-team"].addEventListener("click", () => window.location.assign(roomRoleUrl("team", room)));
elements["spotify-connect"].addEventListener("click", () => void beginSpotifyLogin(room));
elements["spotify-refresh"].addEventListener("click", async () => {
  try {
    await loadDevices();
  } catch (error) {
    toast(error.message);
  }
});
elements["spotify-device"].addEventListener("change", () => {
  saveSpotifyDevice(currentDevice());
  render();
});
elements["spotify-disconnect"].addEventListener("click", () => {
  spotifyPlayer?.disconnect();
  spotifyPlayer = null;
  browserDeviceId = "";
  clearSpotifySession();
  spotifyConnected = false;
  elements["spotify-device-row"].hidden = true;
  elements["spotify-disconnect"].hidden = true;
  elements["spotify-connect"].hidden = false;
  render();
});
elements["play-song"].addEventListener("click", async () => {
  if (!state?.round || !("spotifyUri" in state.round.song)) return;
  playbackBusy = true;
  render();
  try {
    await spotifyPlayer?.activate();
    if (!labPlayback) await playSpotifyTrack(state.round.song.spotifyUri, currentDevice());
    if (!state.round.playbackStarted) {
      const started = await act({ type: "mark_playback_started" });
      if (!started && state?.can.markPlaybackStarted) {
        await act({ type: "mark_playback_started" });
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    playbackBusy = false;
    render();
  }
});
elements["pause-song"].addEventListener("click", async () => {
  playbackBusy = true;
  render();
  try {
    if (!labPlayback) await pauseSpotifyPlayback(currentDevice());
  } catch (error) {
    toast(error.message);
  } finally {
    playbackBusy = false;
    render();
  }
});

async function start() {
  if (window.location.pathname === "/callback") {
    try {
      await configureSpotify();
      await handleSpotifyCallback();
      room = roomFromUrl();
    } catch (error) {
      toast(error.message);
      room = roomFromUrl();
    }
  }
  if (!room) {
    window.location.replace("/");
    return;
  }
  await refresh();
  if (!state) return;
  stopUpdates = createRoomUpdates(room, {
    controllerMode,
    onRevision: refresh,
    onStatus: (status) => {
      elements.connection.textContent = status === "live" ? "Live" : "Reconnecting";
    },
  });
  timerHandle = window.setInterval(updateTimer, 250);
  await initializeSpotify();
}

window.addEventListener("pagehide", () => {
  stopUpdates?.();
  if (timerHandle !== null) window.clearInterval(timerHandle);
});
void start();
