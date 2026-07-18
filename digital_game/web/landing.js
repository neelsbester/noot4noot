import { api, createToast, randomToken, requestId } from "./shared.js";

const toast = createToast();
const loading = document.querySelector("#invite-loading");
const required = document.querySelector("#invite-required");
const entry = document.querySelector("#game-entry");
const roomInput = document.querySelector("#room-code");
const joinTab = document.querySelector("#join-tab");
const createTab = document.querySelector("#create-tab");
const joinPanel = document.querySelector("#join-panel");
const createPanel = document.querySelector("#create-panel");

function selectTab(tab) {
  const joining = tab === "join";
  joinTab.setAttribute("aria-selected", String(joining));
  createTab.setAttribute("aria-selected", String(!joining));
  joinPanel.hidden = !joining;
  createPanel.hidden = joining;
  joinTab.classList.toggle("is-active", joining);
  createTab.classList.toggle("is-active", !joining);
  (joining ? roomInput : document.querySelector("#deck-select")).focus();
}

joinTab.addEventListener("click", () => selectTab("join"));
createTab.addEventListener("click", () => selectTab("create"));

roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/gu, "").slice(0, 4);
});

joinPanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = joinPanel.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const code = roomInput.value.trim().toUpperCase();
    const result = await api(`/api/rooms/${encodeURIComponent(code)}/teams`, {
      method: "POST",
      body: {
        name: document.querySelector("#team-name").value,
        teamToken: randomToken(),
        requestId: requestId(),
      },
    });
    window.location.assign(`/team?room=${encodeURIComponent(result.room.code)}`);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

createPanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = createPanel.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/rooms", {
      method: "POST",
      body: {
        hostToken: randomToken(),
        requestId: requestId(),
        settings: {
          deckId: document.querySelector("#deck-select").value,
          targetCards: Number(document.querySelector("#target-cards").value),
          startingTokens: Number(document.querySelector("#starting-tokens").value),
          challengeTimerSeconds: Number(document.querySelector("#challenge-timer").value),
          titleArtistBonus: document.querySelector("#title-bonus").checked,
        },
      },
    });
    window.location.assign(`/host?room=${encodeURIComponent(result.room.code)}`);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
});

async function initialize() {
  const url = new URL(window.location.href);
  const inviteToken = url.searchParams.get("invite");
  const requestedRoom = url.searchParams.get("room");
  if (inviteToken) {
    url.searchParams.delete("invite");
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);
    try {
      await api("/api/access/redeem", {
        method: "POST",
        body: { inviteToken },
      });
    } catch (error) {
      showRequired();
      toast(error.message);
      return;
    }
  }

  try {
    const [config] = await Promise.all([api("/api/config"), api("/api/access")]);
    const deckSelect = document.querySelector("#deck-select");
    deckSelect.replaceChildren(...config.decks.map((deck) => {
      const option = document.createElement("option");
      option.value = deck.id;
      option.textContent = `${deck.name} · ${deck.songCount} songs`;
      return option;
    }));
    if (requestedRoom) {
      roomInput.value = requestedRoom.toUpperCase().slice(0, 4);
      selectTab("join");
    }
    loading.hidden = true;
    required.hidden = true;
    entry.hidden = false;
    document.querySelector("#access-mark").textContent = "Invite active";
  } catch {
    showRequired();
  }
}

function showRequired() {
  loading.hidden = true;
  entry.hidden = true;
  required.hidden = false;
}

await initialize();
