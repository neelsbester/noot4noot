const $ = selector => document.querySelector(selector);

const ui = {
  connectionBadge: $('#connectionBadge'),
  connectionLabel: $('#connectionLabel'),
  setupCard: $('#setupCard'),
  setupCopy: $('#setupCopy'),
  connectButton: $('#connectButton'),
  targetTitle: $('#targetTitle'),
  targetArtist: $('#targetArtist'),
  roundIndex: $('#roundIndex'),
  recordMark: $('#recordMark'),
  playState: $('#playState'),
  transportProgress: $('#transportProgress'),
  elapsedTime: $('#elapsedTime'),
  buttonOrbit: $('#buttonOrbit'),
  answerButton: $('#answerButton'),
  answerHelp: $('#answerHelp'),
  meter: $('#meter'),
  resultCard: $('#resultCard'),
  resultStamp: $('#resultStamp'),
  resultHeadline: $('#resultHeadline'),
  heardText: $('#heardText'),
  matchedSong: $('#matchedSong'),
  confidenceValue: $('#confidenceValue'),
  latencyValue: $('#latencyValue'),
  retryButton: $('#retryButton'),
  nextButton: $('#nextButton'),
  wrongAnswerCue: $('#wrongAnswerCue'),
  audioBedToggle: $('#audioBedToggle'),
  eventLog: $('#eventLog')
};

const state = {
  songs: [],
  currentSong: null,
  round: 0,
  connected: false,
  connecting: false,
  listening: false,
  answerInFlight: false,
  peer: null,
  dataChannel: null,
  mediaStream: null,
  audioTrack: null,
  releasedAt: 0,
  pressedAt: 0,
  simulationStartedAt: 0,
  simulationElapsed: 0,
  simulationPlaying: false,
  transportTimer: null,
  logs: [],
  resolvedResponseIds: new Set(),
  pendingInputItemId: null,
  cleanupItemId: null,
  cleanupEventId: null,
  cleanupTimer: null,
  cleanupCompletion: null
};

class SyntheticMusicBed {
  constructor() {
    this.context = null;
    this.master = null;
    this.oscillators = [];
    this.timer = null;
    this.step = 0;
  }

  async start() {
    if (!ui.audioBedToggle.checked) return;
    this.stop();
    this.context ||= new AudioContext();
    await this.context.resume();
    const now = this.context.currentTime;
    this.master = this.context.createGain();
    this.master.gain.setValueAtTime(0.0001, now);
    this.master.gain.exponentialRampToValueAtTime(0.035, now + 0.08);
    this.master.connect(this.context.destination);

    [110, 164.81, 220].forEach((frequency, index) => {
      const oscillator = this.context.createOscillator();
      const voiceGain = this.context.createGain();
      oscillator.type = index === 1 ? 'sine' : 'triangle';
      oscillator.frequency.value = frequency;
      voiceGain.gain.value = index === 2 ? 0.22 : 0.4;
      oscillator.connect(voiceGain).connect(this.master);
      oscillator.start();
      this.oscillators.push(oscillator);
    });

    const chords = [
      [110, 164.81, 220],
      [98, 146.83, 196],
      [130.81, 196, 261.63],
      [87.31, 130.81, 174.61]
    ];
    this.timer = window.setInterval(() => {
      this.step = (this.step + 1) % chords.length;
      const time = this.context.currentTime;
      this.oscillators.forEach((oscillator, index) => {
        oscillator.frequency.exponentialRampToValueAtTime(chords[this.step][index], time + 0.16);
      });
    }, 620);
  }

  stop() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    if (!this.master || !this.context) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now);
    this.master.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    const oscillators = this.oscillators.splice(0);
    window.setTimeout(() => oscillators.forEach(oscillator => oscillator.stop()), 90);
    this.master = null;
  }
}

const musicBed = new SyntheticMusicBed();

function reportTelemetry(type, details = {}) {
  const payload = {
    at: new Date().toISOString(),
    type,
    round: state.round,
    targetId: state.currentSong?.id || null,
    connected: state.connected,
    ...details
  };
  fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {
    // Telemetry must never interfere with the game flow.
  });
}

function logEvent(event) {
  const compact = {
    at: new Date().toISOString().slice(11, 23),
    type: event.type,
    ...(event.error ? { error: event.error } : {}),
    ...(event.response?.status ? { status: event.response.status } : {})
  };
  state.logs.unshift(compact);
  state.logs = state.logs.slice(0, 30);
  ui.eventLog.textContent = state.logs.map(item => JSON.stringify(item)).join('\n');
}

function setConnection(status, label) {
  ui.connectionBadge.dataset.state = status;
  ui.connectionLabel.textContent = label;
}

function send(event) {
  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    throw new Error('Realtime data channel is not open');
  }
  state.dataChannel.send(JSON.stringify(event));
  logEvent({ type: `client:${event.type}` });
}

function markAnswerReady() {
  state.answerInFlight = false;
  ui.answerButton.disabled = !state.connected;
  setConnection(state.connected ? 'ready' : 'error', state.connected ? 'Realtime ready' : 'Disconnected');
}

function finishConversationCleanup(outcome) {
  window.clearTimeout(state.cleanupTimer);
  const completion = state.cleanupCompletion;
  const itemId = state.cleanupItemId;
  state.cleanupItemId = null;
  state.cleanupEventId = null;
  state.cleanupTimer = null;
  state.cleanupCompletion = null;
  reportTelemetry('conversation.cleanup.finished', {
    status: outcome,
    message: itemId || ''
  });
  completion?.();
}

function cleanupCurrentInput(onComplete) {
  const itemId = state.pendingInputItemId;
  state.pendingInputItemId = null;
  if (!itemId) {
    onComplete();
    return;
  }

  state.cleanupItemId = itemId;
  state.cleanupEventId = `cleanup-${itemId}`;
  state.cleanupCompletion = onComplete;
  try {
    send({
      event_id: state.cleanupEventId,
      type: 'conversation.item.delete',
      item_id: itemId
    });
    state.cleanupTimer = window.setTimeout(() => {
      if (state.cleanupItemId === itemId) finishConversationCleanup('timeout');
    }, 1500);
  } catch {
    finishConversationCleanup('send_failed');
  }
}

function chooseRandomSong() {
  if (!state.songs.length) return;
  const choices = state.songs.filter(song => song.id !== state.currentSong?.id);
  state.currentSong = choices[Math.floor(Math.random() * choices.length)] || state.songs[0];
  state.round += 1;
  ui.targetTitle.textContent = state.currentSong.title;
  ui.targetArtist.textContent = state.currentSong.artist;
  ui.roundIndex.textContent = String(state.round).padStart(2, '0');
  const wrongChoices = state.songs.filter(song => song.id !== state.currentSong.id);
  const wrong = wrongChoices[Math.floor(Math.random() * wrongChoices.length)];
  ui.wrongAnswerCue.textContent = `“${wrong.title} by ${wrong.artist}”`;
  resetResult();
  startSimulation();
}

function startSimulation() {
  state.simulationElapsed = 0;
  state.simulationStartedAt = performance.now();
  state.simulationPlaying = true;
  ui.recordMark.classList.add('is-playing');
  ui.playState.textContent = 'SIMULATION PLAYING';
  window.clearInterval(state.transportTimer);
  updateTransport();
  state.transportTimer = window.setInterval(updateTransport, 200);
  musicBed.start().catch(() => {});
}

function pauseSimulation() {
  if (state.simulationPlaying) {
    state.simulationElapsed += performance.now() - state.simulationStartedAt;
  }
  state.simulationPlaying = false;
  window.clearInterval(state.transportTimer);
  ui.recordMark.classList.remove('is-playing');
  ui.playState.textContent = 'MUSIC STOPPED';
  musicBed.stop();
  updateTransport();
}

function updateTransport() {
  const elapsed = state.simulationElapsed + (state.simulationPlaying ? performance.now() - state.simulationStartedAt : 0);
  const seconds = Math.floor(elapsed / 1000);
  ui.transportProgress.style.width = `${Math.min(100, (seconds / 30) * 100)}%`;
  ui.elapsedTime.textContent = `0:${String(seconds).padStart(2, '0')}`;
}

function resetResult() {
  ui.resultCard.dataset.verdict = 'waiting';
  ui.resultStamp.textContent = 'WAITING';
  ui.resultHeadline.textContent = 'Your answer will land here.';
  ui.heardText.textContent = state.connected
    ? 'Hold the answer button and speak.'
    : 'Connect, then hold the answer button and speak.';
  ui.matchedSong.textContent = '—';
  ui.confidenceValue.textContent = '—';
  ui.latencyValue.textContent = '—';
}

async function connectRealtime() {
  if (state.connected || state.connecting) return;
  state.connecting = true;
  ui.connectButton.disabled = true;
  ui.connectButton.firstElementChild.textContent = 'Opening channel…';
  setConnection('working', 'Connecting');

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
    state.audioTrack = state.mediaStream.getAudioTracks()[0];
    state.audioTrack.enabled = false;

    state.peer = new RTCPeerConnection();
    state.peer.addTrack(state.audioTrack, state.mediaStream);
    state.peer.addEventListener('connectionstatechange', () => {
      logEvent({ type: `peer:${state.peer.connectionState}` });
      reportTelemetry('peer.state', { peerState: state.peer.connectionState });
      if (['failed', 'disconnected', 'closed'].includes(state.peer.connectionState)) {
        state.connected = false;
        ui.answerButton.disabled = true;
        setConnection('error', state.peer.connectionState);
      }
    });

    state.dataChannel = state.peer.createDataChannel('oai-events');
    state.dataChannel.addEventListener('message', handleServerEvent);

    const channelReady = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Realtime connection timed out')), 15000);
      state.dataChannel.addEventListener('open', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    const response = await fetch('/api/realtime/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp
    });
    const body = await response.text();
    if (!response.ok) {
      let message = body;
      try { message = JSON.parse(body).error || body; } catch { /* plain response */ }
      throw new Error(message);
    }
    await state.peer.setRemoteDescription({ type: 'answer', sdp: body });
    await channelReady;

    state.connected = true;
    state.connecting = false;
    ui.answerButton.disabled = false;
    ui.connectButton.firstElementChild.textContent = 'Microphone connected';
    ui.setupCard.classList.add('is-connected');
    ui.setupCopy.textContent = 'Connection ready. The microphone only sends audio while you hold the answer button.';
    setConnection('ready', 'Realtime ready');
    reportTelemetry('connection.ready', { peerState: state.peer.connectionState });
    resetResult();
  } catch (error) {
    state.connecting = false;
    ui.connectButton.disabled = false;
    ui.connectButton.firstElementChild.textContent = 'Try connection again';
    ui.setupCopy.textContent = error.message;
    setConnection('error', 'Connection failed');
    reportTelemetry('connection.error', { message: error.message });
    closeRealtime();
  }
}

function closeRealtime() {
  window.clearTimeout(state.cleanupTimer);
  state.audioTrack?.stop();
  state.peer?.close();
  state.mediaStream = null;
  state.audioTrack = null;
  state.peer = null;
  state.dataChannel = null;
  state.connected = false;
  state.pendingInputItemId = null;
  state.cleanupItemId = null;
  state.cleanupEventId = null;
  state.cleanupTimer = null;
  state.cleanupCompletion = null;
}

function beginAnswer(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (!state.connected || state.listening || state.answerInFlight) return;
  event.preventDefault();
  if (event.pointerId !== undefined) {
    ui.answerButton.setPointerCapture?.(event.pointerId);
  }
  pauseSimulation();
  resetResult();
  state.listening = true;
  state.pressedAt = performance.now();
  state.audioTrack.enabled = true;
  ui.answerButton.classList.add('is-listening');
  ui.buttonOrbit.classList.add('is-listening');
  ui.meter.classList.add('is-live');
  ui.answerHelp.textContent = 'Listening… release when your answer is complete.';
  setConnection('working', 'Listening');
  reportTelemetry('answer.started');
  try {
    send({ type: 'input_audio_buffer.clear' });
  } catch (error) {
    finishWithError(error.message);
  }
}

async function finishAnswer(event) {
  if (!state.listening) return;
  event?.preventDefault();
  state.listening = false;
  ui.answerButton.classList.remove('is-listening');
  ui.buttonOrbit.classList.remove('is-listening');
  ui.meter.classList.remove('is-live');

  const heldFor = performance.now() - state.pressedAt;
  reportTelemetry('answer.released', { heldMs: Math.round(heldFor) });
  if (heldFor < 280) {
    state.audioTrack.enabled = false;
    ui.answerHelp.textContent = 'That was too quick. Hold the button while you speak.';
    setConnection('ready', 'Realtime ready');
    reportTelemetry('answer.too_short', { heldMs: Math.round(heldFor) });
    return;
  }

  state.answerInFlight = true;
  state.releasedAt = performance.now();
  ui.answerButton.disabled = true;
  ui.answerHelp.textContent = 'The model is resolving your answer…';
  setConnection('working', 'Thinking');

  try {
    send({ type: 'input_audio_buffer.commit' });
    send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        max_output_tokens: 512,
        reasoning: { effort: 'minimal' },
        parallel_tool_calls: false,
        tool_choice: { type: 'function', name: 'submit_song_guess' },
        metadata: { round: String(state.round) }
      }
    });
    state.audioTrack.enabled = false;
  } catch (error) {
    finishWithError(error.message);
  }
}

function handleServerEvent(messageEvent) {
  const event = JSON.parse(messageEvent.data);
  logEvent(event);

  if (event.type === 'error') {
    if (state.cleanupEventId && event.event_id === state.cleanupEventId) {
      reportTelemetry('conversation.cleanup.error', {
        code: event.error?.code || '',
        message: event.error?.message || 'Conversation cleanup failed'
      });
      finishConversationCleanup('error');
      return;
    }
    reportTelemetry('realtime.error', {
      sourceEvent: event.type,
      code: event.error?.code || '',
      message: event.error?.message || 'Realtime API error'
    });
    finishWithError(event.error?.message || 'Realtime API error');
    return;
  }

  if (event.type === 'input_audio_buffer.committed') {
    state.pendingInputItemId = event.item_id || null;
    return;
  }

  if (event.type === 'conversation.item.deleted') {
    if (event.item_id === state.cleanupItemId) finishConversationCleanup('deleted');
    return;
  }

  if (
    event.type === 'response.function_call_arguments.done'
    && event.name === 'submit_song_guess'
  ) {
    try {
      const guess = JSON.parse(event.arguments);
      if (
        typeof guess?.candidate_id !== 'string'
        || typeof guess?.heard_text !== 'string'
        || !Number.isFinite(Number(guess?.confidence))
      ) {
        throw new Error('Incomplete function arguments');
      }
      state.resolvedResponseIds.add(event.response_id);
      reportTelemetry('response.function_arguments.done', {
        latencyMs: Math.round(performance.now() - state.releasedAt),
        resultEvent: event.type
      });
      showResult(guess, event.type);
    } catch {
      // Incomplete responses may emit partial arguments; response.done handles them.
    }
    return;
  }

  if (event.type !== 'response.done') return;

  reportTelemetry('response.done', {
    status: event.response?.status || 'unknown',
    reason: event.response?.status_details?.reason || '',
    message: event.response?.status_details?.error?.message || '',
    outputTypes: (event.response?.output || []).map(item => item.type).join(','),
    inputTokens: event.response?.usage?.input_tokens || 0,
    outputTokens: event.response?.usage?.output_tokens || 0,
    totalTokens: event.response?.usage?.total_tokens || 0
  });

  if (state.resolvedResponseIds.delete(event.response?.id)) {
    cleanupCurrentInput(markAnswerReady);
    return;
  }

  if (event.response?.status !== 'completed') {
    const message = (
      event.response?.status_details?.error?.message
      || event.response?.status_details?.reason
      || `Response ${event.response?.status || 'failed'}`
    );
    cleanupCurrentInput(() => renderError(message));
    return;
  }
  const call = event.response.output?.find(item => item.type === 'function_call' && item.name === 'submit_song_guess');
  if (!call) {
    finishWithError('The model did not return a song guess. Check the raw events below.');
    return;
  }

  try {
    showResult(JSON.parse(call.arguments));
    cleanupCurrentInput(markAnswerReady);
  } catch {
    reportTelemetry('response.invalid_arguments', { rawArguments: call.arguments || '' });
    cleanupCurrentInput(() => renderError('The model returned invalid function arguments.'));
  }
}

function showResult(guess, resultEvent = 'response.done') {
  const latency = Math.round(performance.now() - state.releasedAt);
  const matched = state.songs.find(song => song.id === guess.candidate_id);
  const confidence = Math.max(0, Math.min(1, Number(guess.confidence) || 0));
  let verdict = 'wrong';
  let headline = 'Not this one.';

  if (guess.candidate_id === 'none' || confidence < 0.3) {
    verdict = 'unclear';
    headline = 'I could not place that answer.';
  } else if (guess.candidate_id === state.currentSong.id) {
    verdict = 'correct';
    headline = 'That is the record.';
  }

  ui.resultCard.dataset.verdict = verdict;
  ui.resultStamp.textContent = verdict.toUpperCase();
  ui.resultHeadline.textContent = headline;
  ui.heardText.textContent = guess.heard_text ? `I heard: “${guess.heard_text}”` : 'No transcript returned.';
  ui.matchedSong.textContent = matched ? `${matched.title} / ${matched.artist}` : 'No catalogue match';
  ui.confidenceValue.textContent = `${Math.round(confidence * 100)}%`;
  ui.latencyValue.textContent = `${latency} ms`;
  ui.answerHelp.textContent = 'Try again, replay the round, or choose another song.';
  reportTelemetry('answer.result', {
    latencyMs: latency,
    candidateId: guess.candidate_id,
    heardText: guess.heard_text || '',
    confidence,
    verdict,
    resultEvent
  });
}

function finishWithError(message) {
  if (state.pendingInputItemId && !state.cleanupItemId) {
    cleanupCurrentInput(() => renderError(message));
    return;
  }
  renderError(message);
}

function renderError(message) {
  if (state.audioTrack) state.audioTrack.enabled = false;
  state.listening = false;
  state.answerInFlight = false;
  ui.answerButton.classList.remove('is-listening');
  ui.buttonOrbit.classList.remove('is-listening');
  ui.meter.classList.remove('is-live');
  ui.answerButton.disabled = !state.connected;
  ui.resultCard.dataset.verdict = 'wrong';
  ui.resultStamp.textContent = 'ERROR';
  ui.resultHeadline.textContent = 'The listening channel stumbled.';
  ui.heardText.textContent = message;
  ui.answerHelp.textContent = 'You can retry the same round.';
  setConnection('error', 'API error');
  reportTelemetry('answer.error', { message });
}

function handleKeyboard(event) {
  if (event.code !== 'Space' || event.repeat || event.target.matches('button, input, summary')) return;
  if (event.type === 'keydown') beginAnswer(event);
  else finishAnswer(event);
}

async function initialize() {
  try {
    const [songsResponse, configResponse] = await Promise.all([
      fetch('/songs.json'),
      fetch('/api/config')
    ]);
    state.songs = await songsResponse.json();
    const config = await configResponse.json();
    chooseRandomSong();
    if (!config.apiKeyConfigured) {
      ui.setupCopy.textContent = 'OpenAI key not configured yet. Copy .env.example to .env, add your key, and restart this server.';
      setConnection('error', 'Key needed');
    } else {
      ui.setupCopy.textContent = `Ready to connect securely using ${config.model}. Your API key remains on the server.`;
    }
  } catch (error) {
    ui.setupCopy.textContent = `Could not initialize the lab: ${error.message}`;
    setConnection('error', 'Setup error');
  }
}

ui.connectButton.addEventListener('click', connectRealtime);
ui.answerButton.addEventListener('pointerdown', beginAnswer);
ui.answerButton.addEventListener('pointerup', finishAnswer);
ui.answerButton.addEventListener('pointercancel', finishAnswer);
ui.answerButton.addEventListener('contextmenu', event => event.preventDefault());
ui.retryButton.addEventListener('click', () => {
  if (!state.answerInFlight && !state.listening) {
    resetResult();
    startSimulation();
  }
});
ui.nextButton.addEventListener('click', () => {
  if (!state.answerInFlight && !state.listening) chooseRandomSong();
});
ui.audioBedToggle.addEventListener('change', () => {
  if (ui.audioBedToggle.checked && state.simulationPlaying) musicBed.start().catch(() => {});
  else musicBed.stop();
});
window.addEventListener('keydown', handleKeyboard);
window.addEventListener('keyup', handleKeyboard);
window.addEventListener('beforeunload', closeRealtime);

initialize();
