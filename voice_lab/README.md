# Noot4Noot Voice Answer Lab

An isolated push-to-talk experiment for testing OpenAI Realtime song-answer extraction before it is integrated into either Noot4Noot app.

The browser opens a persistent WebRTC connection to `gpt-realtime-2.1-mini`. A tiny Python server creates the session through OpenAI's unified WebRTC endpoint, keeping the standard API key out of browser code.

## Configure

From the repository root:

```bash
cp voice_lab/.env.example voice_lab/.env
```

Edit `voice_lab/.env` and replace the placeholder with an OpenAI project API key that has access to the Realtime API:

```env
OPENAI_API_KEY=sk-...
OPENAI_INPUT_NOISE_REDUCTION=off
```

The low-latency demo defaults OpenAI input noise reduction to `off`; mobile browser echo
cancellation, noise suppression, and automatic gain control remain enabled. Set the value to
`near_field` if real-world testing in a particularly noisy room proves less accurate.

The `.env` file is ignored by Git.

## Run

```bash
python3 -m voice_lab.server
```

Open `http://127.0.0.1:8787`, click **Connect microphone**, and grant microphone permission.

For each round:

1. The lab displays the simulated correct song and artist.
2. Hold the large answer button while speaking.
3. Release it to commit the audio immediately.
4. The Realtime model returns a structured catalogue guess.
5. Browser code compares the candidate ID with the displayed answer and shows the result, confidence, and round-trip latency.

Each guess uses an out-of-band response. After `response.done`, the browser deletes the
committed audio item and waits for the deletion acknowledgement before enabling the next
answer. Previous guesses therefore do not accumulate in model context or influence later
rounds.

Use **Replay round** to retry the same answer or **Next random song** to select another. The test cue supplies a deliberately wrong answer from the catalogue. The optional synthetic music bed helps test microphone bleed and confirms that pressing Answer stops playback.

## Test

```bash
python3 -m pytest voice_lab/tests -q
```

## Repeatable latency benchmark

The benchmark uses OpenAI TTS once to create a fixed set of raw 24 kHz PCM song-answer
fixtures, plus deterministic room-noise variants that require no extra TTS calls. It feeds
the exact same audio into persistent Realtime WebSocket sessions and measures from
`input_audio_buffer.commit` to the first parseable structured result. Generated audio and
results stay under the ignored `voice_lab/benchmark_artifacts/` directory.

Set up the isolated benchmark dependency and prepare fixtures:

```bash
python3 -m venv voice_lab/.venv
voice_lab/.venv/bin/pip install -r voice_lab/requirements-benchmark.txt
voice_lab/.venv/bin/python -m voice_lab.benchmark prepare
```

Run all model/configuration variants once, or repeat each fixture for a more stable result:

```bash
voice_lab/.venv/bin/python -m voice_lab.benchmark sweep --configs all --repeats 1
voice_lab/.venv/bin/python -m voice_lab.benchmark sweep --configs all --repeats 3
voice_lab/.venv/bin/python -m voice_lab.benchmark sweep \
  --configs rt21-min-512,rt21-min-512-no-nr \
  --acoustic-profile ambient --repeats 3
```

The sweep reports reliability, catalogue accuracy, median latency, p90 latency, minimum
latency, and provider failures. A short default delay keeps larger sweeps below project
token-per-minute limits. Full per-attempt events and token usage are saved in
`voice_lab/benchmark_artifacts/results/latest.json`.

## Phone testing

Microphone capture requires a secure browser context. `localhost` is accepted on the same computer, but a phone opening a LAN IP normally requires HTTPS. Put this lab behind an HTTPS development tunnel before testing from a phone; do not expose port `8787` directly to the internet.
