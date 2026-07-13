import { request, roomFromUrl, saveSession } from './shared.js';

// Spotify only permits an HTTP loopback IP literal, not http://localhost.
// Normalize before a host room is created so OAuth and browser storage share an origin.
if (window.location.hostname === 'localhost') {
  const port = window.location.port ? `:${window.location.port}` : '';
  window.location.replace(`http://127.0.0.1${port}${window.location.pathname}${window.location.search}${window.location.hash}`);
}

const joinTab = document.querySelector('#join-tab');
const hostTab = document.querySelector('#host-tab');
const joinForm = document.querySelector('#join-form');
const hostForm = document.querySelector('#host-form');
const roomInput = document.querySelector('#room-code');
const teamNameInput = document.querySelector('#team-name');
const createRoomButton = document.querySelector('#create-room-button');
const errorElement = document.querySelector('#entry-error');
const testLabLink = document.querySelector('#test-lab-link');

if (['localhost', '127.0.0.1'].includes(window.location.hostname)) testLabLink.hidden = false;

function showMode(mode) {
  const joining = mode === 'join';
  joinTab.classList.toggle('is-active', joining);
  hostTab.classList.toggle('is-active', !joining);
  joinForm.hidden = !joining;
  hostForm.hidden = joining;
  errorElement.textContent = '';
}

joinTab.addEventListener('click', () => showMode('join'));
hostTab.addEventListener('click', () => showMode('host'));

joinForm.addEventListener('submit', async event => {
  event.preventDefault();
  errorElement.textContent = '';
  const room = roomInput.value.trim().toUpperCase();
  try {
    const session = await request(`/api/rooms/${encodeURIComponent(room)}/teams`, {
      method: 'POST',
      body: { name: teamNameInput.value },
    });
    saveSession('team', room, session.token, session.team_id);
    window.location.href = `/team?room=${encodeURIComponent(room)}`;
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

createRoomButton.addEventListener('click', async () => {
  createRoomButton.disabled = true;
  errorElement.textContent = '';
  try {
    const session = await request('/api/rooms', { method: 'POST', body: {} });
    saveSession('host', session.code, session.token);
    window.location.href = `/host?room=${encodeURIComponent(session.code)}`;
  } catch (error) {
    errorElement.textContent = error.message;
    createRoomButton.disabled = false;
  }
});

const linkedRoom = roomFromUrl();
if (linkedRoom) {
  roomInput.value = linkedRoom;
  teamNameInput.focus();
}
