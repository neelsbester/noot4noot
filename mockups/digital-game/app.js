const shell = document.querySelector('.game-shell');
const mysteryCard = document.querySelector('#mystery-card');
const ghost = document.querySelector('#drag-ghost');
const slots = [...document.querySelectorAll('.drop-slot')];
const lockButton = document.querySelector('#lock-button');
const resetButton = document.querySelector('#reset-button');
const selectionCopy = document.querySelector('#selection-copy');
const stageTitle = document.querySelector('#stage-title');
const stageHint = document.querySelector('#stage-hint');
const timelineTitle = document.querySelector('#timeline-title');
const revealBanner = document.querySelector('#reveal-banner');
const resultSymbol = document.querySelector('#result-symbol');
const resultLabel = document.querySelector('#result-label');
const resultTitle = document.querySelector('#result-title');
const resultPoints = document.querySelector('#result-points');
const resultScoreLabel = document.querySelector('#result-score-label');

const challengePanel = document.querySelector('#challenge-panel');
const challengeTitle = document.querySelector('#challenge-title');
const challengeCopy = document.querySelector('#challenge-copy');
const challengeButtons = [...document.querySelectorAll('[data-challenge-team]')];
const closeChallengeButton = document.querySelector('#close-challenge-button');

const hostControlsButton = document.querySelector('#host-controls-button');
const hostDrawer = document.querySelector('#host-drawer');
const hostBackdrop = document.querySelector('#host-backdrop');
const closeHostButton = document.querySelector('#close-host-button');
const hostChallengeCopy = document.querySelector('#host-challenge-copy');
const activeTokenCount = document.querySelector('#active-token-count');
const gameToast = document.querySelector('#game-toast');

const initialTokens = { tangerine: 4, vinyl: 2, blue: 3 };
const teamNames = { tangerine: 'Team Tangerine', vinyl: 'Team Vinyl', blue: 'Blue Notes' };
const teamInitials = { tangerine: 'T', vinyl: 'V', blue: 'B' };

let tokens = { ...initialTokens };
let selectedSlot = null;
let placedCard = null;
let challengeTeam = null;
let challengeSlot = null;
let challengeMode = false;
let challengeResolved = false;
let dragging = false;
let pointerId = null;
let toastTimer = null;

const slotDescriptions = [
  'before <strong>1977</strong>',
  'between <strong>1977</strong> and <strong>1987</strong>',
  'between <strong>1987</strong> and <strong>1999</strong>',
  'between <strong>1999</strong> and <strong>2013</strong>',
  'after <strong>2013</strong>'
];

function showToast(message) {
  window.clearTimeout(toastTimer);
  gameToast.textContent = message;
  gameToast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => gameToast.classList.remove('is-visible'), 2400);
}

function updateTokenUI() {
  document.querySelectorAll('[data-token-team]').forEach(element => {
    element.textContent = tokens[element.dataset.tokenTeam];
  });

  document.querySelectorAll('[data-token-output]').forEach(element => {
    element.textContent = tokens[element.dataset.tokenOutput];
  });

  document.querySelectorAll('[data-buy-card]').forEach(button => {
    button.disabled = tokens[button.dataset.buyCard] < 3;
  });

  challengeButtons.forEach(button => {
    const team = button.dataset.challengeTeam;
    button.disabled = challengeTeam ? team !== challengeTeam : tokens[team] < 1;
  });

  activeTokenCount.textContent = tokens.tangerine;
}

function selectSlot(slot) {
  if (shell.classList.contains('is-locked')) return;

  slots.forEach(candidate => candidate.classList.toggle('is-selected', candidate === slot));
  selectedSlot = slot;
  lockButton.disabled = false;
  selectionCopy.innerHTML = `Placed ${slotDescriptions[Number(slot.dataset.slot)]} · move it or lock in`;
}

function selectChallengeSlot(slot) {
  if (!challengeMode || slot === selectedSlot) return;

  slots.forEach(candidate => {
    candidate.classList.remove('is-challenge-selected');
    delete candidate.dataset.challenger;
  });

  challengeSlot = slot;
  challengeSlot.classList.add('is-challenge-selected');
  challengeSlot.dataset.challenger = teamInitials[challengeTeam];
  lockButton.disabled = false;
  lockButton.querySelector('.lock-idle').textContent = `Lock ${teamNames[challengeTeam]} challenge`;
  selectionCopy.innerHTML = `${teamNames[challengeTeam]} chose ${slotDescriptions[Number(slot.dataset.slot)]}`;
}

function handleSlotClick(slot) {
  if (shell.classList.contains('is-locked') && slot === selectedSlot) {
    revealCard();
    return;
  }

  if (challengeMode) {
    selectChallengeSlot(slot);
  } else {
    selectSlot(slot);
  }
}

function slotAtPoint(x, y) {
  return slots.find(slot => {
    const rect = slot.getBoundingClientRect();
    const padding = 18;
    return x >= rect.left - padding && x <= rect.right + padding && y >= rect.top - padding && y <= rect.bottom + padding;
  });
}

function updateDrag(x, y) {
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
  const hovered = slotAtPoint(x, y);
  slots.forEach(slot => slot.classList.toggle('is-hovered', slot === hovered));
}

function beginDrag(event) {
  if (shell.classList.contains('is-locked')) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  dragging = true;
  pointerId = event.pointerId;
  mysteryCard.setPointerCapture?.(pointerId);
  mysteryCard.classList.add('is-dragging');
  ghost.classList.add('is-visible');
  updateDrag(event.clientX, event.clientY);
  event.preventDefault();
}

function moveDrag(event) {
  if (!dragging || event.pointerId !== pointerId) return;
  updateDrag(event.clientX, event.clientY);
  event.preventDefault();
}

function endDrag(event) {
  if (!dragging || event.pointerId !== pointerId) return;

  const target = slotAtPoint(event.clientX, event.clientY);
  if (target) selectSlot(target);

  dragging = false;
  pointerId = null;
  mysteryCard.classList.remove('is-dragging');
  ghost.classList.remove('is-visible');
  slots.forEach(slot => slot.classList.remove('is-hovered'));
  event.preventDefault();
}

function createPlacedCard() {
  const card = document.createElement('div');
  card.className = 'card card-mystery placed-card';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML = mysteryCard.innerHTML;
  return card;
}

function openChallengeWindow() {
  challengePanel.classList.add('is-visible');
  challengePanel.setAttribute('aria-hidden', 'false');
  hostChallengeCopy.textContent = 'Open · waiting for the first rival team';
  stageTitle.textContent = 'Challenge window open';
  stageHint.textContent = 'Rival teams can spend 1 token to claim an alternative position.';
  selectionCopy.innerHTML = '<strong>Position locked.</strong> Waiting for challenges';
  lockButton.querySelector('.lock-idle').textContent = 'Waiting for rivals';
  updateTokenUI();
}

function lockIn() {
  if (!selectedSlot || shell.classList.contains('is-locked')) return;

  lockButton.classList.add('is-busy');
  lockButton.disabled = true;
  slots.forEach(slot => {
    slot.disabled = true;
    slot.classList.remove('is-hovered');
  });

  window.setTimeout(() => {
    shell.classList.add('is-locked');
    selectedSlot.classList.remove('is-selected');
    selectedSlot.classList.add('is-locked');
    selectedSlot.disabled = false;
    selectedSlot.setAttribute('aria-label', 'Locked mystery card. Waiting for the challenge window.');
    placedCard = createPlacedCard();
    selectedSlot.append(placedCard);
    lockButton.classList.remove('is-busy');
    openChallengeWindow();
  }, 420);
}

function startChallenge(team) {
  if (challengeTeam || tokens[team] < 1) return;

  challengeTeam = team;
  challengeMode = true;
  tokens[team] -= 1;
  challengePanel.classList.add('is-claimed');
  challengeButtons.forEach(button => {
    button.classList.toggle('is-claimed', button.dataset.challengeTeam === team);
  });
  closeChallengeButton.disabled = true;
  closeChallengeButton.textContent = 'Challenge claimed';
  challengeTitle.textContent = `${teamNames[team]} claimed it`;
  challengeCopy.textContent = 'Choose a different gap for the rival team, then lock their challenge.';
  hostChallengeCopy.textContent = `${teamNames[team]} spent 1 token · choosing a position`;
  stageTitle.textContent = 'Challenge claimed';
  stageHint.textContent = `${teamNames[team]} gets one alternative placement before the reveal.`;
  selectionCopy.innerHTML = `<strong>${teamNames[team]}</strong> is choosing a rival position`;
  lockButton.querySelector('.lock-idle').textContent = 'Choose challenge position';
  lockButton.disabled = true;

  slots.forEach(slot => {
    if (slot !== selectedSlot) {
      slot.disabled = false;
      slot.classList.add('is-challenge-open');
    }
  });

  updateTokenUI();
  showToast(`${teamNames[team]} claimed the only challenge for 1 token`);
}

function lockChallenge() {
  if (!challengeMode || !challengeSlot) return;

  challengeMode = false;
  challengeResolved = true;
  challengeSlot.classList.remove('is-challenge-selected');
  challengeSlot.classList.add('is-challenge-locked');
  slots.forEach(slot => {
    slot.classList.remove('is-challenge-open');
    slot.disabled = slot !== selectedSlot;
  });
  placedCard.classList.add('is-ready');
  selectedSlot.setAttribute('aria-label', 'Challenge locked. Tap the mystery card to reveal.');
  lockButton.disabled = true;
  lockButton.querySelector('.lock-idle').textContent = 'Challenge locked';
  challengeTitle.textContent = 'Challenge locked';
  challengeCopy.textContent = `${teamNames[challengeTeam]} has committed to a different position.`;
  hostChallengeCopy.textContent = `${teamNames[challengeTeam]} locked ${slotDescriptions[Number(challengeSlot.dataset.slot)].replace(/<[^>]*>/g, '')}`;
  stageTitle.textContent = 'Both answers are locked';
  stageHint.textContent = 'Tap the glowing mystery card to flip it and settle the challenge.';
  selectionCopy.innerHTML = '<strong>Challenge locked!</strong> Tap the mystery card to reveal';

  window.setTimeout(() => {
    challengePanel.classList.remove('is-visible');
    challengePanel.setAttribute('aria-hidden', 'true');
  }, 650);
}

function closeChallengeWindow() {
  if (challengeTeam) return;

  challengeResolved = true;
  challengePanel.classList.remove('is-visible');
  challengePanel.setAttribute('aria-hidden', 'true');
  placedCard.classList.add('is-ready');
  selectedSlot.setAttribute('aria-label', 'No challenge was made. Tap the mystery card to reveal.');
  lockButton.disabled = true;
  lockButton.querySelector('.lock-idle').textContent = 'Ready to reveal';
  hostChallengeCopy.textContent = 'Closed · no challenge this round';
  stageTitle.textContent = 'No challenge';
  stageHint.textContent = 'Tap the glowing mystery card to reveal the answer.';
  selectionCopy.innerHTML = '<strong>No challenge.</strong> Tap the mystery card to reveal';
}

function revealCard() {
  if (!placedCard || shell.classList.contains('is-revealed')) return;

  if (!challengeResolved) {
    challengePanel.classList.add('is-visible');
    showToast('Close or complete the challenge window before revealing');
    return;
  }

  const activeCorrect = selectedSlot.dataset.slot === '1';
  const challengerCorrect = challengeSlot?.dataset.slot === '1';
  placedCard.classList.remove('is-ready');
  placedCard.classList.add('is-revealed');
  shell.classList.add('is-revealed');
  revealBanner.classList.remove('is-wrong', 'is-challenge-win');

  if (challengerCorrect) {
    placedCard.classList.add('is-wrong', 'is-challenge-won');
    stageTitle.textContent = `${teamNames[challengeTeam]} called it!`;
    stageHint.textContent = '1985 belongs between 1977 and 1987—the rival placement wins.';
    selectionCopy.innerHTML = `<strong>Challenge won!</strong> ${teamNames[challengeTeam]} takes the card`;
    resultSymbol.textContent = '↯';
    resultLabel.textContent = 'CHALLENGE WON';
    resultTitle.textContent = '1985 · TAKE ON ME';
    resultPoints.textContent = teamNames[challengeTeam].replace('Team ', '').toUpperCase();
    resultScoreLabel.textContent = 'TAKES CARD';
    revealBanner.classList.add('is-challenge-win');
    hostChallengeCopy.textContent = `${teamNames[challengeTeam]} won the card`;
  } else if (activeCorrect) {
    placedCard.classList.add('is-correct');
    stageTitle.textContent = 'Nailed it!';
    stageHint.textContent = '1985 fits perfectly between 1977 and 1987.';
    selectionCopy.innerHTML = challengeTeam
      ? `<strong>Challenge denied!</strong> Team Tangerine keeps the card`
      : '<strong>Correct!</strong> The card stays in your timeline';
    resultSymbol.textContent = '✓';
    resultLabel.textContent = challengeTeam ? 'CHALLENGE DENIED' : 'PERFECT PLACEMENT';
    resultTitle.textContent = '1985 · TAKE ON ME';
    resultPoints.textContent = '+1';
    resultScoreLabel.textContent = 'CARD';
    if (challengeTeam) hostChallengeCopy.textContent = `${teamNames[challengeTeam]} lost the challenge token`;
  } else {
    placedCard.classList.add('is-wrong');
    stageTitle.textContent = challengeTeam ? 'Nobody had it' : 'So close';
    stageHint.textContent = 'Take On Me was released in 1985—between 1977 and 1987.';
    selectionCopy.innerHTML = challengeTeam
      ? '<strong>No winner.</strong> The card returns to the deck'
      : '<strong>Not quite.</strong> This card returns to the deck';
    resultSymbol.textContent = '×';
    resultLabel.textContent = challengeTeam ? 'NO ONE HAD IT' : 'NOT THIS TIME';
    resultTitle.textContent = '1985 · TAKE ON ME';
    resultPoints.textContent = '+0';
    resultScoreLabel.textContent = 'CARD';
    revealBanner.classList.add('is-wrong');
    if (challengeTeam) hostChallengeCopy.textContent = 'Both placements missed · no card awarded';
  }

  window.setTimeout(() => {
    revealBanner.classList.add('is-visible');
    revealBanner.setAttribute('aria-hidden', 'false');
  }, 360);
}

function openHostDrawer() {
  hostDrawer.classList.add('is-visible');
  hostBackdrop.classList.add('is-visible');
  hostDrawer.setAttribute('aria-hidden', 'false');
  hostBackdrop.setAttribute('aria-hidden', 'false');
}

function closeHostDrawer() {
  hostDrawer.classList.remove('is-visible');
  hostBackdrop.classList.remove('is-visible');
  hostDrawer.setAttribute('aria-hidden', 'true');
  hostBackdrop.setAttribute('aria-hidden', 'true');
}

function adjustTokens(team, delta) {
  tokens[team] = Math.max(0, tokens[team] + delta);
  updateTokenUI();
  showToast(`${teamNames[team]} now has ${tokens[team]} token${tokens[team] === 1 ? '' : 's'}`);
}

function buyRandomCard(team) {
  if (tokens[team] < 3) return;
  tokens[team] -= 3;
  updateTokenUI();
  if (team === 'tangerine') timelineTitle.textContent = '2 cards to victory';
  showToast(`Random card added to ${teamNames[team]}'s timeline · 3 tokens spent`);
}

function resetDemo() {
  selectedSlot = null;
  placedCard?.remove();
  placedCard = null;
  challengeTeam = null;
  challengeSlot = null;
  challengeMode = false;
  challengeResolved = false;
  dragging = false;
  pointerId = null;
  tokens = { ...initialTokens };

  shell.classList.remove('is-locked', 'is-revealed');
  mysteryCard.classList.remove('is-dragging');
  ghost.classList.remove('is-visible');
  challengePanel.classList.remove('is-visible', 'is-claimed');
  challengePanel.setAttribute('aria-hidden', 'true');
  challengeTitle.textContent = 'Think they placed it wrong?';
  challengeCopy.textContent = 'The first team to challenge spends 1 token and claims the attempt.';
  challengeButtons.forEach(button => button.classList.remove('is-claimed'));
  closeChallengeButton.disabled = false;
  closeChallengeButton.textContent = 'No challenge · continue to reveal';
  revealBanner.className = 'reveal-banner';
  revealBanner.setAttribute('aria-hidden', 'true');
  resultScoreLabel.textContent = 'CARD';
  lockButton.disabled = true;
  lockButton.classList.remove('is-busy');
  lockButton.querySelector('.lock-idle').textContent = 'Lock in position';
  stageTitle.textContent = 'Where does it belong?';
  stageHint.textContent = 'Drag the mystery card into a gap, or tap a gap to place it.';
  selectionCopy.textContent = 'Choose a gap to make your guess';
  timelineTitle.textContent = '3 cards to victory';
  hostChallengeCopy.textContent = 'Not open yet';
  closeHostDrawer();

  slots.forEach(slot => {
    slot.disabled = false;
    slot.classList.remove('is-selected', 'is-locked', 'is-hovered', 'is-challenge-open', 'is-challenge-selected', 'is-challenge-locked');
    delete slot.dataset.challenger;
  });

  updateTokenUI();
}

mysteryCard.addEventListener('pointerdown', beginDrag);
mysteryCard.addEventListener('pointermove', moveDrag);
mysteryCard.addEventListener('pointerup', endDrag);
mysteryCard.addEventListener('pointercancel', endDrag);
mysteryCard.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && !shell.classList.contains('is-locked')) {
    event.preventDefault();
    selectSlot(slots[1]);
  }
});

slots.forEach(slot => slot.addEventListener('click', () => handleSlotClick(slot)));
challengeButtons.forEach(button => button.addEventListener('click', () => startChallenge(button.dataset.challengeTeam)));
closeChallengeButton.addEventListener('click', closeChallengeWindow);
lockButton.addEventListener('click', () => challengeMode ? lockChallenge() : lockIn());
resetButton.addEventListener('click', resetDemo);

hostControlsButton.addEventListener('click', openHostDrawer);
closeHostButton.addEventListener('click', closeHostDrawer);
hostBackdrop.addEventListener('click', closeHostDrawer);

document.querySelectorAll('[data-token-adjust]').forEach(button => {
  button.addEventListener('click', () => adjustTokens(button.dataset.tokenAdjust, Number(button.dataset.delta)));
});

document.querySelectorAll('[data-buy-card]').forEach(button => {
  button.addEventListener('click', () => buyRandomCard(button.dataset.buyCard));
});

updateTokenUI();
