export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function roomFromUrl() {
  return new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() || '';
}

export function seatFromUrl() {
  return new URLSearchParams(window.location.search).get('seat')?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '';
}

function sessionKey(role, room, seat = seatFromUrl()) {
  return `noot4noot_${role}_${room}${seat ? `_${seat}` : ''}`;
}

export function saveSession(role, room, token, teamId = '', seat = seatFromUrl()) {
  localStorage.setItem(sessionKey(role, room, seat), JSON.stringify({ token, teamId }));
}

export function loadSession(role, room, seat = seatFromUrl()) {
  try {
    return JSON.parse(localStorage.getItem(sessionKey(role, room, seat))) || null;
  } catch {
    return null;
  }
}

export async function request(path, { method = 'GET', token = '', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export function gameAction(room, token, action, payload = {}) {
  return request(`/api/rooms/${encodeURIComponent(room)}/actions`, {
    method: 'POST',
    token,
    body: { action, ...payload },
  });
}

export function teamById(state, id) {
  return state?.teams?.find(team => team.id === id) || null;
}

export function decadeClass(year) {
  const numericYear = Number(year);
  if (!Number.isFinite(numericYear)) return 'decade-other';
  const decade = Math.floor(numericYear / 10) * 10;
  return decade >= 1950 && decade <= 2020 ? `decade-${decade}` : 'decade-other';
}

function decadeArt(year) {
  const decade = Math.floor(Number(year) / 10) * 10;
  return Number.isFinite(decade) ? Math.abs(decade / 10) % 4 : 0;
}

export function renderTimeline(songs, { placement = null, challengePlacement = null, interactive = false, challenge = false, reveal = null } = {}) {
  const pieces = [];
  for (let slot = 0; slot <= songs.length; slot += 1) {
    const selected = placement === slot;
    const challenged = challengePlacement === slot;
    const revealTarget = reveal?.correctSlot === slot;
    const wrongAnswer = reveal?.wrongSlots?.includes(slot);
    let gapContent = selected
      ? '<span class="placed-mini-card"><i></i><b>LOCKED</b></span>'
      : challenged
        ? '<span class="challenge-marker">C</span>'
        : `<span>+</span><small>${challenge ? 'CHALLENGE' : slot === 0 ? 'BEFORE' : slot === songs.length ? 'AFTER' : 'DROP'}</small>`;
    if (wrongAnswer) gapContent = '<span class="wrong-placement-marker">×</span><small>WRONG SPOT</small>';
    if (revealTarget) {
      const song = reveal.song;
      gapContent = `<span class="reveal-placement-card ${decadeClass(song.year)}" data-reveal-card data-from-slot="${Number(reveal.fromSlot)}" data-was-correct="${reveal.wasCorrect ? 'true' : 'false'}"><i class="card-art art-${decadeArt(song.year)}"></i><strong>${escapeHtml(song.year)}</strong><span>${escapeHtml(song.title)}</span><small>${escapeHtml(song.artist)}</small></span><b class="correct-placement-label">CORRECT</b>`;
    }
    pieces.push(`
      <button class="timeline-gap ${selected ? 'is-selected' : ''} ${challenged ? 'is-challenged' : ''} ${revealTarget ? 'is-reveal-target' : ''} ${wrongAnswer ? 'is-wrong-answer' : ''}" type="button" data-slot="${slot}" ${interactive ? '' : 'tabindex="-1"'}>
        ${gapContent}
      </button>`);
    if (slot < songs.length) {
      const song = songs[slot];
      pieces.push(`
        <article class="timeline-card ${decadeClass(song.year)}">
          <div class="card-art art-${decadeArt(song.year)}"></div>
          <div><strong>${escapeHtml(song.year)}</strong><span>${escapeHtml(song.title)}</span><small>${escapeHtml(song.artist)}</small></div>
        </article>`);
    }
  }
  return pieces.join('');
}

export function animateRevealPlacement(container) {
  const card = container.querySelector('[data-reveal-card]');
  if (!card) return;
  const target = card.closest('.timeline-gap');
  const source = container.querySelector(`.timeline-gap[data-slot="${card.dataset.fromSlot}"]`);
  target?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });

  window.requestAnimationFrame(() => {
    if (card.dataset.wasCorrect === 'true' || !source || !target) {
      card.classList.add('is-confirmed');
      return;
    }
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    card.style.setProperty('--reveal-start-x', `${sourceRect.left + sourceRect.width / 2 - targetRect.left - targetRect.width / 2}px`);
    card.style.setProperty('--reveal-start-y', `${sourceRect.top + sourceRect.height / 2 - targetRect.top - targetRect.height / 2}px`);
    card.classList.add('is-ready');
    card.getBoundingClientRect();
    window.requestAnimationFrame(() => card.classList.add('is-settled'));
  });
}

export function buildRevealTimeline(round) {
  if (round?.phase !== 'revealed' || round.correct_placement === null) return null;
  const wasCorrect = round.outcome === 'active_won' || round.outcome === 'challenge_won';
  const fromSlot = round.outcome === 'challenge_won' ? round.challenge_placement : round.placement;
  const wrongSlots = [...new Set([round.placement, round.challenge_placement])]
    .filter(slot => slot !== null && slot !== round.correct_placement);
  return {
    song: round.song,
    fromSlot,
    correctSlot: round.correct_placement,
    wasCorrect,
    wrongSlots,
  };
}

export function createToast(element) {
  let timer;
  return message => {
    window.clearTimeout(timer);
    element.textContent = message;
    element.classList.add('is-visible');
    timer = window.setTimeout(() => element.classList.remove('is-visible'), 2600);
  };
}

export function startPolling(callback, delay = 700) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await callback(); } finally { running = false; }
  };
  tick();
  const timer = window.setInterval(tick, delay);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
  return () => { stopped = true; window.clearInterval(timer); };
}
