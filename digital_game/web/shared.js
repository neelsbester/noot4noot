export function roomFromUrl() {
  return new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() || "";
}

export function controllerModeFromUrl() {
  return new URLSearchParams(window.location.search).get("mode") === "controller";
}

export function seatFromUrl() {
  return new URLSearchParams(window.location.search).get("seat") || "";
}

export function roomRoleUrl(role, room, { mode = "", simulation = false } = {}) {
  const url = new URL(`/${role}`, window.location.origin);
  url.searchParams.set("room", room);
  const seat = seatFromUrl();
  if (seat) url.searchParams.set("seat", seat);
  if (mode) url.searchParams.set("mode", mode);
  if (simulation) url.searchParams.set("lab", "1");
  return `${url.pathname}${url.search}`;
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function requestId() {
  return crypto.randomUUID();
}

export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(withCurrentSeat(path), {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
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

export function performAction(room, state, action, controllerMode = false) {
  return api(`/api/rooms/${encodeURIComponent(room)}/actions`, {
    method: "POST",
    body: {
      actionId: requestId(),
      expectedRevision: state.room.revision,
      controllerMode,
      action,
    },
  });
}

export function createRoomUpdates(room, { controllerMode = false, onRevision, onStatus }) {
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let fallbackTimer = null;

  const fallback = () => {
    if (fallbackTimer !== null) return;
    fallbackTimer = window.setInterval(() => {
      if (!document.hidden) void onRevision();
    }, 700);
  };

  const connect = () => {
    if (stopped) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socketUrl = new URL(`${protocol}//${window.location.host}/ws/rooms/${encodeURIComponent(room)}`);
    if (controllerMode) socketUrl.searchParams.set("mode", "controller");
    const seat = seatFromUrl();
    if (seat) socketUrl.searchParams.set("seat", seat);
    socket = new WebSocket(socketUrl);
    socket.addEventListener("open", () => {
      onStatus?.("live");
      if (fallbackTimer !== null) {
        window.clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "revision") void onRevision(message.revision);
      } catch {
        // Ignore malformed notification frames and rely on the next revision.
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      onStatus?.("reconnecting");
      fallback();
      reconnectTimer = window.setTimeout(connect, 1200);
    });
    socket.addEventListener("error", () => socket?.close());
  };

  connect();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void onRevision();
  });
  return () => {
    stopped = true;
    socket?.close();
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
  };
}

function withCurrentSeat(path) {
  const seat = seatFromUrl();
  if (!seat) return path;
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) return path;
  url.searchParams.set("seat", seat);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function decadeClass(year) {
  const decade = Math.floor(Number(year) / 10) * 10;
  return decade >= 1950 && decade <= 2020 ? `decade-${decade}` : "decade-other";
}

export function renderTimeline(container, songs, options = {}) {
  const {
    placement = null,
    challengePlacement = null,
    interactive = false,
    challenge = false,
    correctPlacement = null,
    wrongPlacements = [],
    onSelect,
  } = options;
  container.replaceChildren();
  for (let slot = 0; slot <= songs.length; slot += 1) {
    const gap = document.createElement("button");
    gap.type = "button";
    gap.className = "timeline-gap";
    gap.dataset.slot = String(slot);
    gap.disabled = !interactive;
    const selected = placement === slot;
    const challenged = challengePlacement === slot;
    gap.classList.toggle("is-selected", selected);
    gap.classList.toggle("is-challenged", challenged);
    gap.classList.toggle("is-correct", correctPlacement === slot);
    gap.classList.toggle("is-wrong", wrongPlacements.includes(slot));
    gap.textContent = correctPlacement === slot
      ? "Correct position"
      : wrongPlacements.includes(slot)
        ? "Wrong position"
        : selected
          ? "Your placement"
          : challenged
            ? "Contest placement"
            : challenge
              ? "Contest here"
              : slot === 0
                ? "Before"
                : slot === songs.length
                  ? "After"
                  : "Place here";
    if (interactive) gap.addEventListener("click", () => onSelect?.(slot));
    container.append(gap);

    const song = songs[slot];
    if (!song) continue;
    const card = document.createElement("article");
    card.className = `timeline-card ${decadeClass(song.year)}`;
    const year = document.createElement("strong");
    year.textContent = String(song.year);
    const details = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = song.title;
    const artist = document.createElement("small");
    artist.textContent = song.artist;
    details.append(title, artist);
    card.append(year, details);
    container.append(card);
  }
}

export function revealPlacement(round) {
  if (round?.phase !== "revealed" || round.correctPlacement === null) {
    return { correctPlacement: null, wrongPlacements: [] };
  }
  const wrongPlacements = [round.placement, round.challengePlacement]
    .filter((slot, index, values) => slot !== null && slot !== round.correctPlacement && values.indexOf(slot) === index);
  return { correctPlacement: round.correctPlacement, wrongPlacements };
}

export function teamById(state, id) {
  return state?.teams?.find((team) => team.id === id) || null;
}

export function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value ?? "";
}

export function createToast(element = document.querySelector("#toast")) {
  let timer = null;
  return (message) => {
    if (!element) return;
    if (timer !== null) window.clearTimeout(timer);
    element.textContent = message;
    element.classList.add("is-visible");
    timer = window.setTimeout(() => element.classList.remove("is-visible"), 3200);
  };
}

export function formatTimer(deadline) {
  if (!deadline) return "";
  return String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
}

export function copyText(value) {
  return navigator.clipboard.writeText(value);
}
