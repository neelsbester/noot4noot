import { gameAction, loadSession, request, saveSession } from './shared.js';

const LAB_KEY = 'noot4noot_three_phone_lab';
const seats = {
  host: { role: 'host', seat: 'lab-host', frame: document.querySelector('#host-frame') },
  teamA: { role: 'team', seat: 'lab-team-a', frame: document.querySelector('#team-a-frame') },
  teamB: { role: 'team', seat: 'lab-team-b', frame: document.querySelector('#team-b-frame') },
};

const roomOutput = document.querySelector('#lab-room');
const phaseOutput = document.querySelector('#lab-phase');
const roundOutput = document.querySelector('#lab-round');
const statusOutput = document.querySelector('#lab-status');
const newButton = document.querySelector('#new-lab-game');
const quickStartButton = document.querySelector('#quick-start');
const reloadButton = document.querySelector('#reload-frames');
const openHostLink = document.querySelector('#open-host-tab');
const deviceGrid = document.querySelector('#device-grid');

let room = '';
let hostToken = '';
let polling = false;

function setStatus(message, error = false) {
  statusOutput.textContent = message;
  statusOutput.style.color = error ? '#ff5f6d' : '';
}

function frameUrl(role, roomCode, seat) {
  return `/${role}?room=${encodeURIComponent(roomCode)}&seat=${encodeURIComponent(seat)}&lab=1`;
}

function resizeDevice(canvas) {
  const width = Number(canvas.dataset.width);
  const height = Number(canvas.dataset.height);
  const scale = Math.min(canvas.clientWidth / width, canvas.clientHeight / height);
  const frame = canvas.querySelector('iframe');
  frame.style.transform = `scale(${scale})`;
}

const resizeObserver = new ResizeObserver(entries => entries.forEach(entry => resizeDevice(entry.target)));
document.querySelectorAll('.device-canvas').forEach(canvas => resizeObserver.observe(canvas));

function setFrames(roomCode) {
  for (const [key, config] of Object.entries(seats)) {
    config.frame.src = frameUrl(config.role, roomCode, config.seat);
    config.frame.closest('.device-rig').classList.add('is-online');
    config.frame.parentElement.querySelector('.device-empty').hidden = true;
    config.frame.dataset.seatKey = key;
  }
  openHostLink.href = frameUrl('host', roomCode, seats.host.seat);
  openHostLink.setAttribute('aria-disabled', 'false');
  reloadButton.disabled = false;
}

function persistLab(roomCode) {
  localStorage.setItem(LAB_KEY, JSON.stringify({ room: roomCode }));
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomCode);
  window.history.replaceState({}, document.title, url);
}

async function createLabGame() {
  newButton.disabled = true;
  quickStartButton.disabled = true;
  setStatus('Building three isolated phone sessions…');
  try {
    const host = await request('/api/rooms', { method: 'POST', body: {} });
    const [teamA, teamB] = await Promise.all([
      request(`/api/rooms/${host.code}/teams`, { method: 'POST', body: { name: 'Needle Crew' } }),
      request(`/api/rooms/${host.code}/teams`, { method: 'POST', body: { name: 'Bassline Club' } }),
    ]);

    saveSession('host', host.code, host.token, '', seats.host.seat);
    saveSession('team', host.code, teamA.token, teamA.team_id, seats.teamA.seat);
    saveSession('team', host.code, teamB.token, teamB.team_id, seats.teamB.seat);
    room = host.code;
    hostToken = host.token;
    persistLab(room);
    setFrames(room);
    roomOutput.textContent = room;
    phaseOutput.textContent = 'LOBBY';
    roundOutput.textContent = '--';
    quickStartButton.disabled = false;
    setStatus(`Room ${room} ready. Use all three phones, or quick-start the round.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    newButton.disabled = false;
  }
}

async function restoreLab(roomCode) {
  const hostSession = loadSession('host', roomCode, seats.host.seat);
  const teamASession = loadSession('team', roomCode, seats.teamA.seat);
  const teamBSession = loadSession('team', roomCode, seats.teamB.seat);
  if (!hostSession?.token || !teamASession?.token || !teamBSession?.token) return false;
  try {
    const state = await request(`/api/rooms/${roomCode}/state`, { token: hostSession.token });
    room = roomCode;
    hostToken = hostSession.token;
    setFrames(room);
    updateTelemetry(state);
    setStatus(`Restored room ${room}.`);
    return true;
  } catch {
    return false;
  }
}

function updateTelemetry(state) {
  roomOutput.textContent = state.room.code;
  phaseOutput.textContent = state.round?.phase?.replaceAll('_', ' ').toUpperCase() || state.room.status.toUpperCase();
  roundOutput.textContent = state.round ? String(state.round.number).padStart(2, '0') : '--';
  quickStartButton.disabled = state.room.status !== 'lobby' || state.teams.length < 2;
}

async function pollState() {
  if (!room || !hostToken || polling) return;
  polling = true;
  try {
    updateTelemetry(await request(`/api/rooms/${room}/state`, { token: hostToken }));
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    polling = false;
  }
}

newButton.addEventListener('click', createLabGame);
quickStartButton.addEventListener('click', async () => {
  try {
    updateTelemetry(await gameAction(room, hostToken, 'start_game'));
    setStatus('Round started. The host and both teams are live.');
  } catch (error) {
    setStatus(error.message, true);
  }
});
reloadButton.addEventListener('click', () => {
  Object.values(seats).forEach(({ frame }) => frame.contentWindow?.location.reload());
  setStatus('All three phone views reloaded.');
});

document.querySelectorAll('.focus-device').forEach(button => {
  button.addEventListener('click', () => {
    const rig = button.closest('.device-rig');
    const focusing = !rig.classList.contains('is-focused');
    document.querySelectorAll('.device-rig').forEach(device => device.classList.remove('is-focused'));
    deviceGrid.classList.toggle('has-focus', focusing);
    rig.classList.toggle('is-focused', focusing);
    button.textContent = focusing ? 'Show all' : 'Focus';
    document.querySelectorAll('.focus-device').forEach(other => {
      if (other !== button) other.textContent = 'Focus';
    });
  });
});

window.setInterval(pollState, 900);

const queryRoom = new URLSearchParams(window.location.search).get('room')?.toUpperCase();
let savedRoom = '';
try { savedRoom = JSON.parse(localStorage.getItem(LAB_KEY) || '{}').room || ''; } catch { savedRoom = ''; }
const restored = await restoreLab(queryRoom || savedRoom);
if (!restored) setStatus('Create a room to launch three independent phone sessions.');
