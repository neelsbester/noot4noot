import { api, copyText, createToast } from "./shared.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
const toast = createToast(elements.toast);
let createdUrl = "";

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value) : "Never";
}

function empty(message) {
  const element = document.createElement("p");
  element.className = "message";
  element.textContent = message;
  return element;
}

function inviteCard(invite) {
  const card = document.createElement("article");
  card.className = "data-card";
  const head = document.createElement("div");
  head.className = "data-card-head";
  const label = document.createElement("strong");
  label.textContent = invite.label;
  const status = document.createElement("small");
  const expired = invite.expiresAt !== null && invite.expiresAt <= Date.now();
  status.textContent = invite.revokedAt ? "Revoked" : expired ? "Expired" : "Active";
  head.append(label, status);
  const details = document.createElement("small");
  details.textContent = `${invite.redemptionCount} / ${invite.maxRedemptions} devices · expires ${formatDate(invite.expiresAt)}`;
  card.append(head, details);
  if (!invite.revokedAt && !expired) {
    const revoke = document.createElement("button");
    revoke.className = "button compact danger";
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      if (!window.confirm(`Revoke “${invite.label}”? Active games will continue.`)) return;
      try {
        await api(`/api/admin/invites/${encodeURIComponent(invite.id)}/revoke`, { method: "POST", body: {} });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    });
    card.append(revoke);
  }
  return card;
}

function roomCard(room) {
  const card = document.createElement("article");
  card.className = "data-card";
  const head = document.createElement("div");
  head.className = "data-card-head";
  const code = document.createElement("strong");
  code.textContent = room.code;
  const status = document.createElement("small");
  status.textContent = room.status;
  head.append(code, status);
  const details = document.createElement("small");
  details.textContent = `${room.teamCount} teams · ${room.roundNumber ? `round ${room.roundNumber}` : "lobby"} · active ${formatDate(room.lastActivityAt)}`;
  card.append(head, details);
  if (!["closed", "expired", "finished"].includes(room.status)) {
    const close = document.createElement("button");
    close.className = "button compact danger";
    close.type = "button";
    close.textContent = "Close room";
    close.addEventListener("click", async () => {
      if (!window.confirm(`Close room ${room.code}? Players will not be able to continue.`)) return;
      try {
        await api(`/api/admin/rooms/${encodeURIComponent(room.code)}/close`, { method: "POST", body: {} });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    });
    card.append(close);
  }
  return card;
}

async function refresh() {
  try {
    const [dashboard, config] = await Promise.all([
      api("/api/admin/dashboard"),
      api("/api/config"),
    ]);
    elements["test-lab-link"].hidden = !["local", "staging"].includes(config.environment);
    elements.invites.replaceChildren(...(dashboard.invites.length
      ? dashboard.invites.map(inviteCard)
      : [empty("No invites yet.")]));
    elements.rooms.replaceChildren(...(dashboard.rooms.length
      ? dashboard.rooms.map(roomCard)
      : [empty("No recent rooms.")]));
  } catch (error) {
    toast(error.message);
  }
}

elements["invite-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/admin/invites", {
      method: "POST",
      body: {
        label: elements["invite-label"].value.trim(),
        lifetime: elements["invite-lifetime"].value,
        maxRedemptions: Number(elements["invite-cap"].value),
      },
    });
    createdUrl = result.url;
    elements["invite-url"].textContent = createdUrl;
    elements["invite-output"].hidden = false;
    await refresh();
  } catch (error) {
    toast(error.message);
  }
});
elements["copy-invite"].addEventListener("click", async () => {
  await copyText(createdUrl);
  toast("Invite link copied.");
});
elements.refresh.addEventListener("click", () => void refresh());
void refresh();
