const ENVELOPE_HZ = 1000;
const BANDS = [
  { name: 'low', type: 'lowpass', frequency: 200 },
  { name: 'mid', type: 'bandpass', frequency: 1200, Q: 0.7 },
  { name: 'high', type: 'highpass', frequency: 4000 }
];

/** One peak per millisecond of audio, so zooming in keeps revealing detail. */
function envelope(channel, sampleRate) {
  const perBucket = Math.max(Math.round(sampleRate / ENVELOPE_HZ), 1);
  const peaks = new Float32Array(Math.ceil(channel.length / perBucket));
  for (let bucket = 0; bucket < peaks.length; bucket += 1) {
    let max = 0;
    const start = bucket * perBucket;
    const end = Math.min(start + perBucket, channel.length);
    for (let offset = start; offset < end; offset += 1) {
      const value = Math.abs(channel[offset]);
      if (value > max) max = value;
    }
    peaks[bucket] = max;
  }
  return peaks;
}

function normalise(peaks) {
  const loudest = peaks.reduce((max, value) => Math.max(max, value), 0) || 1;
  for (let index = 0; index < peaks.length; index += 1) peaks[index] /= loudest;
  return peaks;
}

async function filtered(buffer, band) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new Offline(1, buffer.length, buffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const filter = offline.createBiquadFilter();
  filter.type = band.type;
  filter.frequency.value = band.frequency;
  if (band.Q) filter.Q.value = band.Q;
  source.connect(filter).connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return envelope(rendered.getChannelData(0), rendered.sampleRate);
}

/**
 * Peak envelope of the whole track plus one per frequency band, so the
 * waveform can be coloured by what the audio is made of at each moment.
 * Falls back to the plain envelope when offline rendering is unavailable.
 */
export async function analyseWaveform(buffer, { normalised = true } = {}) {
  const scale = normalised ? normalise : (peaks) => peaks;
  const peak = scale(envelope(buffer.getChannelData(0), buffer.sampleRate));
  if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return { peak };
  try {
    const [low, mid, high] = await Promise.all(BANDS.map((band) => filtered(buffer, band)));
    return { peak, low: scale(low), mid: scale(mid), high: scale(high) };
  } catch {
    return { peak };
  }
}

/**
 * Envelope of a stem mix: every stem scaled by its fader and summed, so the
 * drawn waveform is the audio that is actually audible. Weights of 0 (muted or
 * not soloed) simply drop out.
 */
export function mixWaveforms(entries) {
  const audible = entries.filter(([, weight]) => weight > 0);
  if (audible.length === 0) return null;
  const length = Math.min(...audible.map(([analysis]) => analysis.peak.length));
  const banded = audible.every(([analysis]) => analysis.low && analysis.mid && analysis.high);

  const sum = (key) => {
    const values = new Float32Array(length);
    for (const [analysis, weight] of audible) {
      const band = analysis[key];
      for (let index = 0; index < length; index += 1) values[index] += band[index] * weight;
    }
    return values;
  };

  const peak = sum('peak');
  const loudest = peak.reduce((max, value) => Math.max(max, value), 0) || 1;
  const scale = (values) => {
    for (let index = 0; index < values.length; index += 1) values[index] /= loudest;
    return values;
  };

  if (!banded) return { peak: scale(peak) };
  return { peak: scale(peak), low: scale(sum('low')), mid: scale(sum('mid')), high: scale(sum('high')) };
}
