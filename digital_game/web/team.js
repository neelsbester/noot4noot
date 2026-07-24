import {
  api,
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
  runLockSweep,
  snapshotMotion,
  teamById,
} from "./shared.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const toast = createToast(elements.toast);
const room = roomFromUrl();
let state = null;
let selectedPlacement = null;
let selectedChallengePlacement = null;
let stopUpdates = null;
let timerHandle = null;
let highestSeenRevision = -1;
let activeMotion = null;

function self() {
  return teamById(state, state?.viewer.teamId);
}

function setSection(name) {
  for (const section of ["loading", "lobby", "game", "finished"]) {
    elements[section].hidden = section !== name;
  }
}

async function act(action) {
  try {
    acceptSnapshot(await performAction(room, state, action));
    return true;
  } catch (error) {
    await refresh();
    if (error.code === "stale_state" && action.type === "set_ready" && state) {
      try {
        acceptSnapshot(await performAction(room, state, action));
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

function teamRow(team) {
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
  detail.textContent = state.room.status === "lobby"
    ? (team.ready ? "Ready" : "Not ready")
    : `${team.cardCount} cards · ${team.tokens} tokens`;
  main.append(name, detail);
  row.append(initial, main);
  return row;
}

function renderLobby() {
  setSection("lobby");
  const team = self();
  elements["lobby-title"].textContent = `${team?.name || "Your team"} is in.`;
  elements["lobby-teams"].replaceChildren(...state.teams.map(teamRow));
  elements.ready.textContent = team?.ready ? "Not ready yet" : "I’m ready";
  elements.ready.classList.toggle("primary", !team?.ready);
  elements["lobby-host-controls"].href = roomRoleUrl("host", room, { mode: "controller" });
}

function turnCopy(round, active, challenger) {
  const mine = state.viewer.teamId;
  if (round.phase === "turn_start") {
    return round.activeTeamId === mine
      ? ["Your turn", "Before the host starts the song, you may buy one random card."]
      : [`${active?.name || "Another team"} is up`, "The host is waiting to start their song."];
  }
  if (round.phase === "placement") {
    return round.activeTeamId === mine
      ? ["Place the mystery song", "Tap a gap, then lock your choice. You may request another song first."]
      : [`${active?.name || "The active team"} is placing`, "Listen closely. You may get a chance to contest."];
  }
  if (round.phase === "challenge" && round.challengeTeamId === mine) {
    return ["You claimed the contest", "Choose a different gap and lock it."];
  }
  if (round.phase === "challenge" && round.activeTeamId === mine) {
    return ["Your placement is locked", challenger ? `${challenger.name} is contesting it.` : "Waiting for the other teams."];
  }
  if (round.phase === "challenge") {
    return challenger
      ? [`${challenger.name} claimed the contest`, "The first contest is the only one this round."]
      : ["Contest or pass", "Spend one token to choose a different position, or choose no contest."];
  }
  if (round.outcome === "active_won") return [`${active?.name || "The active team"} got the card`, `${round.song.title} — ${round.song.artist} (${round.song.year})`];
  if (round.outcome === "challenge_won") return [`${challenger?.name || "The challenger"} stole the card`, `${round.song.title} — ${round.song.artist} (${round.song.year})`];
  return ["Nobody got the card", `${round.song.title} — ${round.song.artist} (${round.song.year})`];
}

function renderGame() {
  setSection("game");
  const round = state.round;
  const team = self();
  const active = teamById(state, round.activeTeamId);
  const challenger = teamById(state, round.challengeTeamId);
  const [title, copy] = turnCopy(round, active, challenger);
  elements["round-number"].textContent = String(round.number);
  elements["team-name"].textContent = team?.name || "—";
  elements.phase.textContent = round.phase.replaceAll("_", " ");
  elements["turn-title"].textContent = title;
  elements["turn-copy"].textContent = copy;
  elements["card-count"].textContent = String(team?.cardCount ?? 0);
  elements["token-count"].textContent = String(team?.tokens ?? 0);
  const previousActive = teamById(state, activeMotion?.previousActiveTeamId);
  renderTurnTeam(
    elements["timeline-title"],
    active?.name || "Active",
    previousActive?.name,
    Boolean(activeMotion?.turnChange),
    " timeline",
  );
  elements["host-controls"].href = roomRoleUrl("host", room, { mode: "controller" });
  const tokenDelta = activeMotion?.tokenDeltas[team?.id] ?? 0;
  elements["token-count"].classList.toggle("motion-token-ring", tokenDelta !== 0);
  elements["token-count"].dataset.tokenDelta = tokenDelta > 0 ? `+${tokenDelta}` : String(tokenDelta);

  const canPlace = state.can.place;
  const canChallengePlace = state.can.placeChallenge;
  const reveal = revealPlacement(round);
  renderTimeline(elements.timeline, state.activeTimeline, {
    placement: selectedPlacement ?? round.placement,
    challengePlacement: selectedChallengePlacement ?? round.challengePlacement,
    interactive: canPlace || canChallengePlace,
    challenge: canChallengePlace,
    ...reveal,
    onSelect: (slot) => {
      if (canPlace) {
        selectedPlacement = slot;
        void act({ type: "place", teamId: state.viewer.teamId, slot });
      } else {
        selectedChallengePlacement = slot;
        void act({ type: "place_challenge", teamId: state.viewer.teamId, slot });
      }
    },
  });
  const winner = teamById(state, round.winnerTeamId);
  renderRevealCard(
    elements["round-reveal-card"],
    round,
    winner?.name || "",
    Boolean(activeMotion?.reveal),
    Boolean(activeMotion?.earnedCard),
  );

  elements["placement-help"].textContent = copy;
  elements["buy-card"].hidden = !state.can.buyRandomCard;
  elements["replace-song"].hidden = !state.can.replaceSong;
  elements["lock-placement"].hidden = !state.can.lockPlacement;
  elements.contest.hidden = !state.can.contest;
  elements.pass.hidden = !state.can.passChallenge;
  elements["lock-challenge"].hidden = !state.can.lockChallenge;
  updateTimer();
}

function renderFinished() {
  setSection("finished");
  const winner = teamById(state, state.room.winnerTeamId);
  elements["result-title"].textContent = winner ? `${winner.name} wins.` : "Game complete.";
  elements["result-copy"].textContent = winner ? `${winner.cardCount} cards completed their timeline.` : "The deck is complete.";
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
}

function render() {
  elements["header-room"].textContent = room || "----";
  if (!state) return;
  if (state.room.status === "lobby") renderLobby();
  else if (state.room.status === "playing") renderGame();
  else renderFinished();
}

async function refresh() {
  try {
    const next = await api(`/api/rooms/${encodeURIComponent(room)}/state`);
    acceptSnapshot(next);
  } catch (error) {
    toast(error.message);
    if ([401, 404].includes(error.status)) window.setTimeout(() => window.location.assign("/"), 1200);
  }
}

function acceptSnapshot(next) {
  if (next.room.revision < highestSeenRevision || next.room.revision < (state?.room.revision ?? -1)) {
    return false;
  }
  highestSeenRevision = Math.max(highestSeenRevision, next.room.revision);
  if (state && next.room.revision === state.room.revision) return false;
  activeMotion = snapshotMotion(state, next);
  state = next;
  selectedPlacement = state.round?.placement ?? null;
  selectedChallengePlacement = state.round?.challengePlacement ?? null;
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

elements.ready.addEventListener("click", () => void act({ type: "set_ready", teamId: state.viewer.teamId, ready: !self().ready }));
elements["buy-card"].addEventListener("click", () => void act({ type: "buy_random_card", teamId: state.viewer.teamId }));
elements["replace-song"].addEventListener("click", () => {
  if (window.confirm("Spend one token and discard this song?")) void act({ type: "replace_song", teamId: state.viewer.teamId });
});
elements["lock-placement"].addEventListener("click", () => void runLockSweep(
  elements["lock-placement"],
  () => act({ type: "lock_placement", teamId: state.viewer.teamId }),
));
elements.contest.addEventListener("click", () => void act({ type: "contest", teamId: state.viewer.teamId }));
elements.pass.addEventListener("click", () => void act({ type: "pass_challenge", teamId: state.viewer.teamId }));
elements["lock-challenge"].addEventListener("click", () => void runLockSweep(
  elements["lock-challenge"],
  () => act({ type: "lock_challenge", teamId: state.viewer.teamId }),
));

async function start() {
  if (!room) {
    window.location.replace("/");
    return;
  }
  await refresh();
  if (!state) return;
  stopUpdates = createRoomUpdates(room, {
    onRevision: refresh,
    onStatus: (status) => {
      elements.connection.textContent = status === "live" ? "Live" : "Reconnecting";
    },
  });
  timerHandle = window.setInterval(updateTimer, 250);
}

window.addEventListener("pagehide", () => {
  stopUpdates?.();
  if (timerHandle !== null) window.clearInterval(timerHandle);
});
void start();
