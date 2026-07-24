const views = {
  host: { role: "host", seat: "lab-host", simulation: true },
  "team-a": { role: "team", seat: "lab-team-a", simulation: false },
  "team-b": { role: "team", seat: "lab-team-b", simulation: false },
};

const status = document.querySelector("#launcher-status");
const requestedView = new URLSearchParams(window.location.search).get("view") || "";

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

async function openPhone() {
  const view = views[requestedView];
  if (!view) {
    status.textContent = "Choose host, team-a, or team-b in the launcher URL.";
    return;
  }
  try {
    const response = await fetch("/api/admin/test-lab", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...localAdminHeaders(),
      },
      body: "{}",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not create a test room (${response.status})`);
    const destination = new URL(`/${view.role}`, window.location.origin);
    destination.searchParams.set("room", data.room);
    destination.searchParams.set("seat", view.seat);
    if (view.simulation) destination.searchParams.set("lab", "1");
    window.location.replace(destination);
  } catch (error) {
    status.textContent = error.message;
  }
}

void openPhone();
