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
export async function analyseWaveform(buffer) {
  const peak = normalise(envelope(buffer.getChannelData(0), buffer.sampleRate));
  if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return { peak };
  try {
    const [low, mid, high] = await Promise.all(BANDS.map((band) => filtered(buffer, band)));
    return { peak, low: normalise(low), mid: normalise(mid), high: normalise(high) };
  } catch {
    return { peak };
  }
}
