import { requestId } from "./shared.js";

const LAB_ROOM_KEY = "noot4noot_test_lab_room";
const seats = {
  host: {
    seat: "lab-host",
    role: "host",
    frame: document.querySelector("#host-frame"),
    open: document.querySelector("#open-host"),
  },
  teamA: {
    seat: "lab-team-a",
    role: "team",
    frame: document.querySelector("#team-a-frame"),
    open: document.querySelector("#open-team-a"),
  },
  teamB: {
    seat: "lab-team-b",
    role: "team",
    frame: document.querySelector("#team-b-frame"),
    open: document.querySelector("#open-team-b"),
  },
};

const roomOutput = document.querySelector("#lab-room");
const phaseOutput = document.querySelector("#lab-phase");
const roundOutput = document.querySelector("#lab-round");
const statusOutput = document.querySelector("#lab-status");
const newButton = document.querySelector("#new-room");
const quickStartButton = document.querySelector("#quick-start");
const reloadButton = document.querySelector("#reload-frames");
const fullHostLink = document.querySelector("#full-host");
const deviceGrid = document.querySelector("#device-grid");

let room = "";
let polling = false;

function localAdminHeaders() {
  const hostname = window.location.hostname;
  const localNetwork = ["127.0.0.1", "localhost"].includes(hostname)
    || hostname.startsWith("10.")
    || hostname.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(hostname);
  return localNetwork
    ? { "X-Noot4Noot-Admin-Email": "neelsbester1993@gmail.com" }
    : {};
}

async function labApi(path, { method = "GET", body, admin = false } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(admin ? localAdminHeaders() : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.code = data.code || "request_failed";
    error.status = response.status;
    throw error;
  }
  return data;
}

function seatPath(path, seat) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("seat", seat);
  return `${url.pathname}${url.search}`;
}

function frameUrl(role, seat, simulation = false) {
  const url = new URL(`/${role}`, window.location.origin);
  url.searchParams.set("room", room);
  url.searchParams.set("seat", seat);
  if (simulation) url.searchParams.set("lab", "1");
  return `${url.pathname}${url.search}`;
}

function setStatus(message, error = false) {
  statusOutput.textContent = message;
  statusOutput.classList.toggle("is-error", error);
}

function loadFrames() {
  seats.host.frame.src = frameUrl("host", seats.host.seat, true);
  seats.teamA.frame.src = frameUrl("team", seats.teamA.seat);
  seats.teamB.frame.src = frameUrl("team", seats.teamB.seat);
  for (const { frame, open, role, seat } of Object.values(seats)) {
    frame.closest(".device").classList.add("is-online");
    frame.parentElement.querySelector(".empty-state").hidden = true;
    open.href = frameUrl(role, seat, role === "host");
    open.setAttribute("aria-disabled", "false");
  }
  fullHostLink.href = frameUrl("host", seats.host.seat);
  fullHostLink.setAttribute("aria-disabled", "false");
  reloadButton.disabled = false;
}

function rememberRoom() {
  localStorage.setItem(LAB_ROOM_KEY, room);
  const url = new URL(window.location.href);
  url.searchParams.set("room", room);
  window.history.replaceState({}, document.title, url);
}

function updateTelemetry(state) {
  roomOutput.textContent = state.room.code;
  phaseOutput.textContent = state.round?.phase?.replaceAll("_", " ") || state.room.status;
  roundOutput.textContent = state.round?.number ? String(state.round.number) : "—";
  quickStartButton.disabled = state.room.status !== "lobby" || state.teams.length < 2;
  setStatus(statusForState(state));
}

function statusForState(state) {
  if (state.room.status === "lobby") {
    return `Room ${state.room.code} is ready. Use the phones manually or start with both teams ready.`;
  }
  if (state.room.status === "finished") {
    return "The test game is finished. Create a new room or use the host rematch control.";
  }
  const active = state.teams.find((team) => team.isActive)?.name || "The active team";
  if (state.round.phase === "turn_start") {
    return `Round ${state.round.number} is ready. Use Play this song in the host phone.`;
  }
  if (state.round.phase === "placement") {
    return `${active} is placing the mystery song.`;
  }
  if (state.round.phase === "challenge") {
    return "The placement is locked. Contest or pass from the rival phone.";
  }
  return `Round ${state.round.number} is revealed. Use Next round in the host phone when ready.`;
}

async function stateFor(seat) {
  return labApi(seatPath(`/api/rooms/${encodeURIComponent(room)}/state`, seat));
}

async function actAs(seat, state, action) {
  return labApi(seatPath(`/api/rooms/${encodeURIComponent(room)}/actions`, seat), {
    method: "POST",
    body: {
      actionId: requestId(),
      expectedRevision: state.room.revision,
      controllerMode: false,
      action,
    },
  });
}

async function createRoom() {
  newButton.disabled = true;
  quickStartButton.disabled = true;
  setStatus("Creating one host and two isolated team sessions…");
  try {
    if (room) {
      await labApi(`/api/admin/rooms/${encodeURIComponent(room)}/close`, {
        method: "POST",
        body: {},
        admin: true,
      }).catch(() => {});
    }
    const created = await labApi("/api/admin/test-lab", {
      method: "POST",
      body: {},
      admin: true,
    });
    room = created.room;
    rememberRoom();
    loadFrames();
    roomOutput.textContent = room;
    phaseOutput.textContent = "lobby";
    roundOutput.textContent = "—";
    quickStartButton.disabled = false;
    setStatus(`Room ${room} is ready. Use the phones manually or start with both teams ready.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    newButton.disabled = false;
  }
}

async function quickStart() {
  quickStartButton.disabled = true;
  setStatus("Marking both teams ready and starting round one…");
  try {
    let teamAState = await stateFor(seats.teamA.seat);
    const teamA = teamAState.teams.find((team) => team.id === teamAState.viewer.teamId);
    if (!teamA?.ready) {
      teamAState = await actAs(
        seats.teamA.seat,
        teamAState,
        { type: "set_ready", teamId: teamAState.viewer.teamId, ready: true },
      );
    }
    let teamBState = await stateFor(seats.teamB.seat);
    const teamB = teamBState.teams.find((team) => team.id === teamBState.viewer.teamId);
    if (!teamB?.ready) {
      teamBState = await actAs(
        seats.teamB.seat,
        teamBState,
        { type: "set_ready", teamId: teamBState.viewer.teamId, ready: true },
      );
    }
    const hostState = await stateFor(seats.host.seat);
    const started = await actAs(seats.host.seat, hostState, { type: "start_game" });
    updateTelemetry(started);
  } catch (error) {
    setStatus(error.message, true);
    await pollState();
  }
}

async function restoreRoom(candidate) {
  if (!candidate || !/^[A-HJ-NP-Z2-9]{4}$/u.test(candidate)) return false;
  room = candidate;
  try {
    const state = await stateFor(seats.host.seat);
    loadFrames();
    updateTelemetry(state);
    setStatus(`Restored test room ${room}.`);
    return true;
  } catch {
    room = "";
    localStorage.removeItem(LAB_ROOM_KEY);
    return false;
  }
}

async function pollState() {
  if (!room || polling || document.hidden) return;
  polling = true;
  try {
    updateTelemetry(await stateFor(seats.host.seat));
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    polling = false;
  }
}

newButton.addEventListener("click", () => void createRoom());
quickStartButton.addEventListener("click", () => void quickStart());
reloadButton.addEventListener("click", () => {
  for (const { frame } of Object.values(seats)) frame.contentWindow?.location.reload();
  setStatus("All three phone views reloaded.");
});

for (const button of document.querySelectorAll(".focus-device")) {
  button.addEventListener("click", () => {
    const device = button.closest(".device");
    const focusing = !device.classList.contains("is-focused");
    for (const item of document.querySelectorAll(".device")) item.classList.remove("is-focused");
    for (const item of document.querySelectorAll(".focus-device")) item.textContent = "Focus";
    deviceGrid.classList.toggle("has-focus", focusing);
    device.classList.toggle("is-focused", focusing);
    button.textContent = focusing ? "Show all" : "Focus";
  });
}

window.setInterval(() => void pollState(), 900);
const requestedRoom = new URLSearchParams(window.location.search).get("room")?.toUpperCase() || "";
const savedRoom = localStorage.getItem(LAB_ROOM_KEY)?.toUpperCase() || "";
if (!await restoreRoom(requestedRoom || savedRoom)) {
  setStatus("Create a room to launch the three independent phones.");
}
