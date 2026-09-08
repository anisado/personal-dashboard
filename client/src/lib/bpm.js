const MIN_BPM = 60;
const MAX_BPM = 200;
const ANALYSIS_RATE = 22050;
const FRAME = 1024;
const HOP = 256;
const FPS = ANALYSIS_RATE / HOP;
/** Tempi far from here are usually the double or half of the real one. */
const PREFERRED_BPM = 125;
const PREFERENCE_WIDTH = 1.1;

/** Mono mixdown at a fixed rate, so the analysis is independent of the file. */
async function monoSamples(buffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new Offline(1, Math.ceil(buffer.duration * ANALYSIS_RATE), ANALYSIS_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  return (await offline.startRendering()).getChannelData(0);
}

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let offset = 0; offset < len / 2; offset += 1) {
        const a = start + offset;
        const b = a + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Spectral flux: how much energy rises between successive spectra. Onsets of
 * any instrument show up here, unlike a plain amplitude threshold which only
 * catches loud low-frequency hits.
 */
function onsetEnvelope(samples) {
  const frames = Math.floor((samples.length - FRAME) / HOP);
  if (frames < 16) return null;

  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);

  const bins = FRAME / 2;
  const previous = new Float32Array(bins);
  const flux = new Float32Array(frames);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * HOP;
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = Math.log1p(20 * Math.hypot(re[bin], im[bin]));
      const rise = magnitude - previous[bin];
      if (rise > 0) sum += rise;
      previous[bin] = magnitude;
    }
    flux[frame] = sum;
  }

  // keep only what stands out from its neighbourhood, so slow build-ups and
  // overall loudness changes do not drown the beats
  const half = Math.round(FPS * 0.12);
  const envelope = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    let count = 0;
    for (let i = Math.max(frame - half, 0); i < Math.min(frame + half, frames); i += 1) {
      sum += flux[i];
      count += 1;
    }
    envelope[frame] = Math.max(flux[frame] - sum / count, 0);
  }
  return envelope;
}

function autocorrelation(envelope, maxLag) {
  const values = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < envelope.length; i += 1) sum += envelope[i] * envelope[i + lag];
    values[lag] = sum / (envelope.length - lag);
  }
  return values;
}

function at(values, lag) {
  if (lag < 1 || lag >= values.length - 1) return 0;
  const low = Math.floor(lag);
  return values[low] + (values[low + 1] - values[low]) * (lag - low);
}

/**
 * Comb-filter score: a real tempo lines up with the onset envelope at its beat
 * period and at whole multiples of it, which rules out periods that are not a
 * beat at all.
 */
function combScore(correlation, bpm) {
  const lag = (FPS * 60) / bpm;
  return (
    at(correlation, lag) +
    0.7 * at(correlation, lag * 2) +
    0.5 * at(correlation, lag * 3) +
    0.3 * at(correlation, lag * 4)
  );
}

/** Multiples of a beat score alike, so lean towards a human-countable tempo. */
function scoreTempo(correlation, bpm) {
  const distance = Math.log2(bpm / PREFERRED_BPM) / PREFERENCE_WIDTH;
  return combScore(correlation, bpm) * Math.exp(-0.5 * distance * distance);
}

/** Onset energy collected by a pulse train of period `lag` starting at `phase`. */
function pulseTrain(envelope, lag, phase) {
  let sum = 0;
  for (let position = phase; position < envelope.length; position += lag) {
    sum += at(envelope, position);
  }
  return sum;
}

/**
 * Land the grid on the beats: search period and phase around the detected
 * tempo for the pulse train that collects the most onset energy, so the grid
 * sits on the transients and does not drift across the track.
 */
function alignGrid(envelope, lag) {
  let best = { lag, phase: 0, score: -1 };
  for (let step = -20; step <= 20; step += 1) {
    const candidate = lag * (1 + step * 0.001);
    for (let phase = 0; phase < candidate; phase += 0.25) {
      const score = pulseTrain(envelope, candidate, phase);
      if (score > best.score) best = { lag: candidate, phase, score };
    }
  }
  return best;
}

/**
 * Estimate the tempo of a decoded track, with the offset of the first beat so
 * a beat grid can be drawn. Returns null when there is no clear beat (speech,
 * ambient recordings, very short clips).
 */
export async function detectBpm(buffer) {
  if (buffer.duration < 5) return null;
  if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return null;

  const envelope = onsetEnvelope(await monoSamples(buffer));
  if (!envelope) return null;

  const energy = envelope.reduce((sum, value) => sum + value, 0);
  if (energy === 0) return null;

  const correlation = autocorrelation(envelope, Math.ceil(((FPS * 60) / MIN_BPM) * 4));

  let best = null;
  let bestScore = 0;
  let total = 0;
  let candidates = 0;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.1) {
    const score = scoreTempo(correlation, bpm);
    total += Math.max(score, 0);
    candidates += 1;
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }

  // a flat score curve means the track has no tempo to find
  const average = total / candidates;
  if (!best || average <= 0 || bestScore / average < 1.5) return null;

  const grid = alignGrid(envelope, (FPS * 60) / best);
  // flux at a frame is the rise from the frame before it, and a frame reacts
  // to a transient anywhere inside its window, so the hit itself sits a hop
  // plus half a window later than the frame the energy lands on
  const offset = ((grid.phase + 1) * HOP + FRAME / 2) / ANALYSIS_RATE;
  const period = grid.lag / FPS;
  return {
    bpm: Math.round(((FPS * 60) / grid.lag) * 100) / 100,
    offset: ((offset % period) + period) % period
  };
}
