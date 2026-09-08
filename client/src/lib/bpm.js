const MIN_BPM = 70;
const MAX_BPM = 180;

/** Isolate the percussive low end so beats stand out as amplitude peaks. */
async function lowEnd(buffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new Offline(1, buffer.length, buffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;

  const lowpass = offline.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 150;
  lowpass.Q.value = 1;

  const highpass = offline.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 40;
  highpass.Q.value = 1;

  source.connect(lowpass).connect(highpass).connect(offline.destination);
  source.start(0);
  return (await offline.startRendering()).getChannelData(0);
}

/** Peaks above a threshold, with a 250 ms refractory window so one hit counts once. */
function peaksAbove(samples, threshold, sampleRate) {
  const gap = Math.floor(sampleRate * 0.25);
  const peaks = [];
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) < threshold) continue;
    peaks.push(index);
    index += gap;
  }
  return peaks;
}

function tempoCounts(peaks, sampleRate) {
  const counts = new Map();
  for (let index = 0; index < peaks.length; index += 1) {
    for (let ahead = 1; ahead <= 10 && index + ahead < peaks.length; ahead += 1) {
      const seconds = (peaks[index + ahead] - peaks[index]) / sampleRate;
      if (seconds <= 0) continue;
      let tempo = 60 / seconds;
      while (tempo < MIN_BPM) tempo *= 2;
      while (tempo > MAX_BPM) tempo /= 2;
      const rounded = Math.round(tempo);
      counts.set(rounded, (counts.get(rounded) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Estimate the tempo of a decoded track. Returns null when there is no clear
 * beat (speech, ambient recordings, very short clips).
 */
export async function detectBpm(buffer) {
  if (buffer.duration < 5) return null;
  if (!(window.OfflineAudioContext || window.webkitOfflineAudioContext)) return null;

  const samples = await lowEnd(buffer);
  const loudest = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (loudest === 0) return null;

  let peaks = [];
  for (let ratio = 0.9; ratio >= 0.3; ratio -= 0.05) {
    peaks = peaksAbove(samples, loudest * ratio, buffer.sampleRate);
    if (peaks.length > 30) break;
  }
  if (peaks.length < 10) return null;

  const counts = tempoCounts(peaks, buffer.sampleRate);
  let best = null;
  let bestCount = 0;
  let total = 0;
  for (const [tempo, count] of counts) {
    total += count;
    // fold neighbouring estimates together, they are the same tempo
    const grouped = count + (counts.get(tempo - 1) || 0) + (counts.get(tempo + 1) || 0);
    if (grouped > bestCount) {
      bestCount = grouped;
      best = tempo;
    }
  }

  // a flat histogram means no tempo was actually found
  if (!best || bestCount / total < 0.05) return null;
  return best;
}
