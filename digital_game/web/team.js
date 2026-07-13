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
  startPolling,
  teamById,
} from './shared.js';

const room = roomFromUrl();
const session = loadSession('team', room);
const token = session?.token || '';
const viewerTeamId = session?.teamId || '';
const loading = document.querySelector('#team-loading');
const lobby = document.querySelector('#team-lobby');
const game = document.querySelector('#team-game');
const timeline = document.querySelector('#team-timeline');
const mainButton = document.querySelector('#team-main-button');
const noChallengeButton = document.querySelector('#no-challenge-button');
const mysteryCard = document.querySelector('#team-mystery-card');
const resultBanner = document.querySelector('#team-result');
const ghost = document.querySelector('#drag-ghost');
const toast = createToast(document.querySelector('#toast'));

let state = null;
let lastRevision = -1;
let actionMode = '';
let dragging = false;
let pointerId = null;
let resultTimer = null;

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function viewerTeam() {
  return teamById(state, viewerTeamId);
}

async function act(action, payload = {}) {
  try {
    state = await gameAction(room, token, action, payload);
    lastRevision = state.room.revision;
    render();
  } catch (error) {
    toast(error.message);
    if (error.code === 'challenge_claimed') await refreshState();
  }
}

function configureMainButton(mode, label, disabled = false) {
  actionMode = mode;
  mainButton.disabled = disabled;
  mainButton.innerHTML = `${escapeHtml(label)} <span>${mode === 'reveal' ? '↻' : mode === 'claim_challenge' ? '!' : '✓'}</span>`;
}

function renderLobby() {
  const team = viewerTeam();
  loading.hidden = true;
  lobby.hidden = false;
  game.hidden = true;
  resultBanner.hidden = true;
  setText('#team-name', team?.name || 'YOUR TEAM');
  setText('#team-token-count', team?.tokens ?? 0);
  setText('#team-room-code', room);
  setText('#team-status', 'Waiting in lobby');
}

function phasePresentation(round, team, activeTeam, challenger) {
  const isActive = team.id === round.active_team_id;
  const isChallenger = team.id === round.challenge_team_id;

  if (round.phase === 'placement') {
    if (isActive) return ['YOUR TURN', 'Where does it belong?', 'Drag the mystery card into a gap, or tap a gap.'];
    return ['LISTEN CLOSELY', `${activeTeam.name} is placing`, 'Your timeline is shown while you wait for the challenge window.'];
  }
  if (round.phase === 'challenge') {
    if (isActive && !challenger) return ['POSITION LOCKED', 'Challenge window open', 'Another team can spend 1 token to challenge your position.'];
    if (isActive) return ['CHALLENGED', `${challenger.name} called it`, 'They are choosing a different position on your timeline.'];
    if (!challenger && round.viewer_passed) return ['PASSED', 'No challenge from you', 'Waiting for the other teams to decide.'];
    if (!challenger) return ['CHALLENGE WINDOW', 'Think they got it wrong?', 'Challenge for 1 token, or pass with no challenge.'];
    if (isChallenger) return ['YOUR CHALLENGE', 'Choose another gap', 'Place your challenge somewhere different from the locked card.'];
    return ['TOO LATE', `${challenger.name} claimed it`, 'Only one team can challenge each card.'];
  }
  if (round.phase === 'reveal_ready') {
    if (isActive) return ['READY', 'Flip the card', challenger ? 'Your placement and the challenge are both locked.' : 'Nobody challenged your position.'];
    return ['ANSWERS LOCKED', 'Time for the reveal', `${activeTeam.name} can flip the mystery card now.`];
  }
  if (round.phase === 'revealed') {
    return ['REVEALED', `${round.song.year} · ${round.song.title}`, round.song.artist];
  }
  return ['ROUND', 'Listen closely', ''];
}

function renderResult(round, activeTeam, challenger) {
  window.clearTimeout(resultTimer);
  if (round.phase !== 'revealed') {
    resultBanner.hidden = true;
    resultBanner.className = 'result-banner';
    return;
  }

  const winner = teamById(state, round.winner_team_id);
  resultBanner.hidden = false;
  const resultClass = round.outcome === 'challenge_won' ? 'is-challenge' : round.outcome === 'no_winner' ? 'is-wrong' : '';
  resultBanner.className = `result-banner ${resultClass}`;
  setText('#result-song', `${round.song.year} · ${round.song.title}`);
  setText('#result-artist', round.song.artist);

  if (round.outcome === 'challenge_won') {
    setText('#result-symbol', '↯');
    setText('#result-label', 'CHALLENGE WON');
    setText('#result-owner', winner?.name || challenger?.name || 'CHALLENGER');
  } else if (round.outcome === 'active_won') {
    setText('#result-symbol', '✓');
    setText('#result-label', challenger ? 'CHALLENGE DENIED' : 'PERFECT PLACEMENT');
    setText('#result-owner', winner?.name || activeTeam.name);
  } else {
    setText('#result-symbol', '×');
    setText('#result-label', 'NO ONE HAD IT');
    setText('#result-owner', 'NO CARD');
  }
  resultTimer = window.setTimeout(() => resultBanner.classList.add('is-visible'), 1450);
}

function bindTimeline(interactiveAction) {
  timeline.querySelectorAll('.timeline-gap').forEach(gap => {
    gap.disabled = !interactiveAction;
    if (interactiveAction) gap.addEventListener('click', () => act(interactiveAction, { slot: Number(gap.dataset.slot) }));
  });
}

function renderGame() {
  const round = state.round;
  const team = viewerTeam();
  const activeTeam = teamById(state, round.active_team_id);
  const challenger = teamById(state, round.challenge_team_id);
  const isActive = team.id === round.active_team_id;
  const isChallenger = team.id === round.challenge_team_id;
  const [kicker, title, copy] = phasePresentation(round, team, activeTeam, challenger);
  noChallengeButton.hidden = !state.can.pass_challenge;

  loading.hidden = true;
  lobby.hidden = true;
  game.hidden = false;
  setText('#team-name', team.name);
  setText('#team-token-count', team.tokens);
  setText('#team-status', isActive ? 'Your turn' : `${activeTeam.name}'s turn`);
  setText('#team-stage-kicker', kicker);
  setText('#team-stage-title', title);
  setText('#team-stage-copy', copy);
  setText('#team-round-number', String(round.number).padStart(2, '0'));
  setText('#team-phase', round.phase.replace('_', ' ').toUpperCase());

  const revealed = round.phase === 'revealed';
  mysteryCard.classList.toggle('is-flipped', revealed);
  mysteryCard.classList.toggle('can-drag', Boolean(state.can.place));
  mysteryCard.classList.toggle('is-waiting', round.phase === 'challenge' || round.phase === 'reveal_ready');
  if (revealed) {
    const revealFace = document.querySelector('#team-reveal-face');
    revealFace.className = `mystery-front ${decadeClass(round.song.year)}`;
    revealFace.innerHTML = `<strong>${escapeHtml(round.song.year)}</strong><span>${escapeHtml(round.song.title)}</span><small>${escapeHtml(round.song.artist)}</small>`;
  }

  let songs = state.viewer_timeline;
  let placement = null;
  let challengePlacement = null;
  let interactiveAction = '';
  let timelineKicker = 'YOUR TIMELINE';
  let timelineOwner = team.name;
  let help = `${team.card_count} / ${state.room.target_cards} cards`;

  if (isActive || round.phase !== 'placement') {
    songs = state.active_timeline;
    timelineOwner = activeTeam.name;
    timelineKicker = isActive ? 'YOUR TIMELINE' : 'ACTIVE TIMELINE';
    if (!revealed) {
      placement = round.placement;
      challengePlacement = round.challenge_placement;
    }
  }
  if (state.can.place) {
    interactiveAction = 'place';
    help = round.placement === null ? 'Choose a gap' : 'Move it or lock in';
  } else if (state.can.place_challenge) {
    interactiveAction = 'place_challenge';
    help = round.challenge_placement === null ? 'Choose a rival gap' : 'Move it or lock challenge';
  } else if (round.phase === 'challenge') {
    help = challenger
      ? `${challenger.name} holds the challenge`
      : round.viewer_passed
        ? `You passed · ${round.challenge_pass_count}/${round.challenge_pass_total} rivals decided`
        : 'Waiting for first challenge';
  }

  setText('#timeline-kicker', timelineKicker);
  setText('#timeline-owner', timelineOwner);
  setText('#timeline-help', help);
  timeline.innerHTML = renderTimeline(songs, {
    placement,
    challengePlacement,
    interactive: Boolean(interactiveAction),
    challenge: interactiveAction === 'place_challenge',
    reveal: buildRevealTimeline(round),
  });
  bindTimeline(interactiveAction);
  if (revealed) {
    help = round.outcome === 'active_won' || round.outcome === 'challenge_won'
      ? `Correct · gap ${round.correct_placement + 1}`
      : `Moving to gap ${round.correct_placement + 1}`;
    setText('#timeline-help', help);
    animateRevealPlacement(timeline);
  }

  if (state.can.lock_placement) {
    configureMainButton('lock_placement', 'Lock in position');
    setText('#team-action-copy', `Gap ${round.placement + 1} selected · this cannot be moved after locking`);
  } else if (state.can.place && round.placement === null) {
    configureMainButton('', 'Choose a position', true);
    setText('#team-action-copy', 'Listen to the song, then place the mystery card');
  } else if (state.can.claim_challenge) {
    configureMainButton('claim_challenge', 'Challenge for 1 token');
    setText('#team-action-copy', 'Only the first rival team can claim · passing cannot be undone');
  } else if (state.can.pass_challenge) {
    configureMainButton('', 'No tokens to challenge', true);
    setText('#team-action-copy', 'Pass to close the challenge window');
  } else if (state.can.lock_challenge) {
    configureMainButton('lock_challenge', 'Lock challenge');
    setText('#team-action-copy', `Your token is spent · gap ${round.challenge_placement + 1} selected`);
  } else if (state.can.place_challenge) {
    configureMainButton('', 'Choose rival position', true);
    setText('#team-action-copy', 'Choose a different gap from the active team');
  } else if (state.can.reveal) {
    configureMainButton('reveal', 'Flip & reveal');
    setText('#team-action-copy', 'Tap the card or button to settle the round');
  } else {
    configureMainButton('', round.phase === 'revealed' ? 'Waiting for host' : 'Waiting…', true);
    setText('#team-action-copy', round.phase === 'revealed' ? 'The host will start the next round' : 'Game state will update automatically');
  }

  renderResult(round, activeTeam, challenger);
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
      window.setTimeout(() => window.location.assign(`/?room=${encodeURIComponent(room)}`), 1200);
    }
  }
}

function gapAtPoint(x, y) {
  return [...timeline.querySelectorAll('.timeline-gap:not(:disabled)')].find(gap => {
    const rect = gap.getBoundingClientRect();
    return x >= rect.left - 16 && x <= rect.right + 16 && y >= rect.top - 16 && y <= rect.bottom + 16;
  });
}

function startDrag(event) {
  if (!state?.can?.place || (event.pointerType === 'mouse' && event.button !== 0)) return;
  dragging = true;
  pointerId = event.pointerId;
  mysteryCard.setPointerCapture?.(pointerId);
  mysteryCard.classList.add('is-dragging');
  ghost.classList.add('is-visible');
  moveDrag(event);
  event.preventDefault();
}

function moveDrag(event) {
  if (!dragging || event.pointerId !== pointerId) return;
  ghost.style.left = `${event.clientX}px`;
  ghost.style.top = `${event.clientY}px`;
  const target = gapAtPoint(event.clientX, event.clientY);
  timeline.querySelectorAll('.timeline-gap').forEach(gap => gap.classList.toggle('is-hovered', gap === target));
  event.preventDefault();
}

function endDrag(event) {
  if (!dragging || event.pointerId !== pointerId) return;
  const target = gapAtPoint(event.clientX, event.clientY);
  dragging = false;
  pointerId = null;
  mysteryCard.classList.remove('is-dragging');
  ghost.classList.remove('is-visible');
  timeline.querySelectorAll('.timeline-gap').forEach(gap => gap.classList.remove('is-hovered'));
  if (target) act('place', { slot: Number(target.dataset.slot) });
  event.preventDefault();
}

mainButton.addEventListener('click', () => {
  if (actionMode) act(actionMode);
});
noChallengeButton.addEventListener('click', () => act('pass_challenge'));
mysteryCard.addEventListener('click', () => {
  if (state?.can?.reveal) act('reveal');
});
mysteryCard.addEventListener('pointerdown', startDrag);
mysteryCard.addEventListener('pointermove', moveDrag);
mysteryCard.addEventListener('pointerup', endDrag);
mysteryCard.addEventListener('pointercancel', endDrag);

if (!room || !token || !viewerTeamId) {
  window.location.replace(`/?room=${encodeURIComponent(room)}`);
} else {
  startPolling(refreshState);
}
