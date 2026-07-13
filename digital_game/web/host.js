import {
  animateRevealPlacement,
  buildRevealTimeline,
  createToast,
  decadeClass,
  escapeHtml,
  gameAction,
  loadSession,
  renderTimeline,
  request,
  roomFromUrl,
  saveSession,
  startPolling,
  teamById,
} from './shared.js';
import {
  beginSpotifyLogin,
  configureSpotify,
  getSpotifyDevices,
  getSpotifyToken,
  handleSpotifyCallback,
  loadSpotifyDevice,
  playSpotifyTrack,
  saveSpotifyDevice,
  transferSpotifyPlayback,
} from './spotify.js';
import { createBrowserSpotifyPlayer } from './spotify-browser-player.js';

const loading = document.querySelector('#host-loading');
const lobby = document.querySelector('#host-lobby');
const game = document.querySelector('#host-game');
const toast = createToast(document.querySelector('#toast'));

let room = '';
let token = '';
let config = null;
let state = null;
let lastRevision = -1;
let spotifyConnected = false;
let browserPlayer = null;
let browserDeviceId = '';

function normalizeHostLoopbackOrigin() {
  const currentRoom = roomFromUrl();
  if (window.location.hostname === 'localhost') {
    const port = window.location.port ? `:${window.location.port}` : '';
    const target = new URL(`http://127.0.0.1${port}${window.location.pathname}${window.location.search}`);
    const session = loadSession('host', currentRoom);
    if (session?.token) target.hash = `host_session=${encodeURIComponent(JSON.stringify(session))}`;
    window.location.replace(target.toString());
    return true;
  }

  const migration = new URLSearchParams(window.location.hash.slice(1)).get('host_session');
  if (window.location.hostname === '127.0.0.1' && currentRoom && migration) {
    try {
      const session = JSON.parse(migration);
      if (session?.token) saveSession('host', currentRoom, session.token, session.teamId || '');
    } catch {
      // An invalid migration fragment is ignored and normal session validation handles it.
    }
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  }
  return false;
}

const changingOrigin = normalizeHostLoopbackOrigin();

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

async function act(action, payload = {}) {
  try {
    state = await gameAction(room, token, action, payload);
    lastRevision = state.room.revision;
    render();
  } catch (error) {
    toast(error.message);
  }
}

function renderLobby() {
  loading.hidden = true;
  lobby.hidden = false;
  game.hidden = true;
  setText('#header-room-code', room);
  setText('#lobby-room-code', room);
  setText('#lobby-team-count', `${state.teams.length} / 2 minimum`);
  const joinUrl = `${config?.lan_url || window.location.origin}/?room=${encodeURIComponent(room)}`;
  setText('#join-url', joinUrl);

  const list = document.querySelector('#lobby-team-list');
  list.innerHTML = state.teams.length
    ? state.teams.map((team, index) => `<div class="lobby-team"><span>${index + 1}</span><strong>${escapeHtml(team.name)}</strong><i>READY</i></div>`).join('')
    : '<div class="empty-team"><span>+</span><p>Waiting for the first team…</p></div>';
  document.querySelector('#start-game-button').disabled = !state.can.start_game;
}

function phaseCopy(round, activeTeam, challenger) {
  if (round.phase === 'placement') return [`${activeTeam.name} is placing`, 'The active team is deciding where the card belongs.'];
  if (round.phase === 'challenge' && !challenger) return ['Challenge window open', 'The first rival team to spend a token claims the challenge.'];
  if (round.phase === 'challenge') return [`${challenger.name} challenged`, 'Waiting for the challenger to choose and lock another gap.'];
  if (round.phase === 'reveal_ready') return ['Both answers are locked', 'The card can now be flipped to settle the round.'];
  if (round.phase === 'revealed') {
    if (round.outcome === 'active_won') return [`${activeTeam.name} got it`, 'The card has been added to their timeline.'];
    if (round.outcome === 'challenge_won') return [`${challenger?.name || 'The challenger'} stole it`, 'The challenge was correct and the card changes hands.'];
    return ['Nobody had it', 'The card returns to the deck.'];
  }
  return ['Round in progress', ''];
}

function renderHostTeams() {
  const list = document.querySelector('#host-team-list');
  list.innerHTML = state.teams.map(team => `
    <article class="host-team-card ${team.is_active ? 'is-active' : ''}">
      <div class="host-team-title"><span>${escapeHtml(team.name.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(team.name)}</strong><small>${team.card_count} / ${state.room.target_cards} cards</small></div><output>${team.tokens}</output></div>
      <div class="host-token-actions">
        <button type="button" data-adjust-team="${team.id}" data-delta="-1" aria-label="Remove token">−</button>
        <button class="award" type="button" data-adjust-team="${team.id}" data-delta="1">Title + artist <b>+1</b></button>
        <button type="button" data-adjust-team="${team.id}" data-delta="1" aria-label="Add token" ${team.tokens >= 5 ? 'disabled' : ''}>+</button>
        <button class="buy" type="button" data-buy-team="${team.id}" ${team.tokens < 3 ? 'disabled' : ''}>Random card <b>−3</b></button>
      </div>
    </article>`).join('');
}

function renderGame() {
  loading.hidden = true;
  lobby.hidden = true;
  game.hidden = false;
  const round = state.round;
  const activeTeam = teamById(state, round.active_team_id);
  const challenger = teamById(state, round.challenge_team_id);
  const [title, copy] = phaseCopy(round, activeTeam, challenger);

  setText('#header-room-code', room);
  setText('#host-round-number', String(round.number).padStart(2, '0'));
  setText('#host-active-team', activeTeam?.name || '—');
  setText('#host-phase', round.phase.replace('_', ' ').toUpperCase());
  setText('#host-stage-title', title);
  setText('#host-stage-copy', copy);
  setText('#board-team-name', activeTeam?.name || '—');

  const revealed = round.phase === 'revealed';
  const mysteryCard = document.querySelector('#host-mystery-card');
  mysteryCard.classList.toggle('is-flipped', revealed);
  if (revealed) {
    const song = round.song;
    const revealFace = document.querySelector('#host-reveal-face');
    revealFace.className = `mystery-front ${decadeClass(song.year)}`;
    revealFace.innerHTML = `<strong>${escapeHtml(song.year)}</strong><span>${escapeHtml(song.title)}</span><small>${escapeHtml(song.artist)}</small>`;
  }

  const hostTimeline = document.querySelector('#host-timeline');
  hostTimeline.innerHTML = renderTimeline(state.active_timeline, {
    placement: revealed ? null : round.placement,
    challengePlacement: revealed ? null : round.challenge_placement,
    reveal: buildRevealTimeline(round),
  });
  if (revealed) animateRevealPlacement(hostTimeline);

  const boardStatus = revealed
    ? round.outcome === 'active_won' || round.outcome === 'challenge_won'
      ? `Correct placement · gap ${round.correct_placement + 1}`
      : `Should have been gap ${round.correct_placement + 1}`
    : round.challenge_team_id
      ? `${challenger?.name || 'A rival'} challenged`
      : round.placement === null ? 'Waiting for their choice' : `Gap ${round.placement + 1} selected`;
  setText('#board-status', boardStatus);

  const closeChallenge = document.querySelector('#close-challenge-button');
  const revealButton = document.querySelector('#host-reveal-button');
  const nextButton = document.querySelector('#next-round-button');
  closeChallenge.hidden = !state.can.close_challenge;
  revealButton.hidden = !state.can.reveal;
  nextButton.hidden = !state.can.next_round;

  let actionCopy = 'Waiting for the active team…';
  if (state.can.close_challenge) actionCopy = 'No rival has challenged yet.';
  if (round.phase === 'challenge' && challenger) actionCopy = `${challenger.name} holds the challenge.`;
  if (state.can.reveal) actionCopy = 'Ready for the big reveal.';
  if (state.can.next_round) actionCopy = state.room.status === 'finished' ? 'A team reached the winning total.' : 'Round complete.';
  setText('#host-action-copy', actionCopy);

  let challengeText = 'Not open yet';
  if (round.phase === 'challenge' && !challenger) challengeText = `Open · ${round.challenge_pass_count}/${round.challenge_pass_total} rivals passed`;
  if (round.phase === 'challenge' && challenger) challengeText = `${challenger.name} spent 1 token`;
  if (round.phase === 'reveal_ready' && challenger) challengeText = `${challenger.name} locked a rival position`;
  if (revealed && round.outcome === 'challenge_won') challengeText = `${challenger?.name} won and stole the card`;
  if (revealed && challenger && round.outcome !== 'challenge_won') challengeText = `${challenger.name} lost the challenge token`;
  if (revealed && !challenger) challengeText = 'No challenge this round';
  setText('#challenge-status-copy', challengeText);
  renderHostTeams();

  const spotifyUrl = round.song.spotify_url || '#';
  const fallback = document.querySelector('#spotify-fallback-link');
  fallback.href = spotifyUrl;
  fallback.hidden = !round.song.spotify_url;
  const selectedDevice = document.querySelector('#spotify-device-select').value;
  document.querySelector('#play-song-button').disabled = !spotifyConnected || !selectedDevice || !round.song.spotify_uri;
}

function render() {
  if (!state) return;
  if (state.room.status === 'lobby') renderLobby();
  else renderGame();
}

async function refreshState() {
  try {
    const fresh = await request(`/api/rooms/${encodeURIComponent(room)}/state`, { token });
    if (fresh.room.revision !== lastRevision) {
      state = fresh;
      lastRevision = state.room.revision;
      render();
    }
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      toast(error.message);
      window.setTimeout(() => window.location.assign('/'), 1200);
    }
  }
}

async function refreshDevices() {
  const devices = await getSpotifyDevices();
  if (browserDeviceId && !devices.some(device => device.id === browserDeviceId)) {
    devices.unshift({ id: browserDeviceId, name: 'This browser', type: 'Browser' });
  }
  const select = document.querySelector('#spotify-device-select');
  const saved = loadSpotifyDevice();
  const selected = devices.some(device => device.id === saved)
    ? saved
    : browserDeviceId || (devices.length === 1 ? devices[0].id : '');
  select.innerHTML = '<option value="">Choose device</option>' + devices.map(device => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)} · ${escapeHtml(device.type)}</option>`).join('');
  select.value = selected;
  if (selected) saveSpotifyDevice(selected);
  document.querySelector('#spotify-device-row').hidden = false;
  spotifyConnected = true;
  document.querySelector('#spotify-connect-button').textContent = 'Spotify connected';
  if (!devices.length) toast('No output yet. Open Spotify on a device, or reconnect to enable browser audio.');
  render();
}

async function initializeBrowserPlayback() {
  try {
    browserPlayer = await createBrowserSpotifyPlayer({
      getToken: getSpotifyToken,
      onError: message => toast(message),
    });
    browserDeviceId = browserPlayer.deviceId;
    await refreshDevices();
  } catch (error) {
    toast(`${error.message} You can still choose the Spotify app as an output.`);
  }
}

async function initializeSpotify() {
  try {
    config = await configureSpotify();
    const callbackToken = await handleSpotifyCallback();
    room = roomFromUrl();
    if (callbackToken || await getSpotifyToken()) {
      await refreshDevices();
      initializeBrowserPlayback();
    }
  } catch (error) {
    toast(error.message);
  }
}

document.querySelector('#start-game-button').addEventListener('click', () => act('start_game'));
document.querySelector('#close-challenge-button').addEventListener('click', () => act('close_challenge'));
document.querySelector('#host-reveal-button').addEventListener('click', () => act('reveal'));
document.querySelector('#next-round-button').addEventListener('click', () => act('next_round'));

document.querySelector('#copy-join-url').addEventListener('click', async () => {
  const value = document.querySelector('#join-url').textContent;
  await navigator.clipboard.writeText(value).catch(() => {});
  toast('Join address copied');
});

document.querySelector('#host-team-list').addEventListener('click', event => {
  const adjust = event.target.closest('[data-adjust-team]');
  const buy = event.target.closest('[data-buy-team]');
  if (adjust) act('adjust_tokens', { team_id: adjust.dataset.adjustTeam, delta: Number(adjust.dataset.delta) });
  if (buy) act('buy_random_card', { team_id: buy.dataset.buyTeam });
});

document.querySelector('#spotify-connect-button').addEventListener('click', () => {
  if (window.self !== window.top) {
    window.open(window.location.href, 'noot4noot-host');
    toast('Host opened full-size for Spotify login');
    return;
  }
  beginSpotifyLogin(room).catch(error => toast(error.message));
});
document.querySelector('#spotify-refresh-button').addEventListener('click', () => refreshDevices().catch(error => toast(error.message)));
document.querySelector('#spotify-device-select').addEventListener('change', event => {
  saveSpotifyDevice(event.target.value);
  render();
});
document.querySelector('#play-song-button').addEventListener('click', async () => {
  try {
    const deviceId = document.querySelector('#spotify-device-select').value;
    if (!deviceId) throw new Error('Choose a Spotify output first');
    if (deviceId === browserDeviceId) await browserPlayer.activate();
    await transferSpotifyPlayback(deviceId);
    await playSpotifyTrack(state.round.song.spotify_uri, deviceId);
    toast('Mystery song is playing');
  } catch (error) {
    toast(error.message);
  }
});

if (!changingOrigin) {
  await initializeSpotify();
  room = room || roomFromUrl();
  const session = loadSession('host', room);
  if (!room || !session?.token) {
    window.location.replace('/');
  } else {
    token = session.token;
    setText('#header-room-code', room);
    startPolling(refreshState);
  }
}
