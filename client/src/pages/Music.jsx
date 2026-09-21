import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { detectBpm } from '../lib/bpm.js';
import { analyseWaveform, mixWaveforms } from '../lib/waveform.js';

const MAX_ZOOM = 32;
const ROW_SIZES = ['compact', 'normal', 'large'];
// the offscreen render covers more than the visible window, so scrolling it
// during playback is a blit instead of a redraw
const CACHE_SPANS = 3;
const MAX_CACHE_PIXELS = 8192;
const UNPLAYED_ALPHA = 0.4;

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Amplitude for every pixel column of the visible window: the loudest peak in
 * the column when zoomed out, a linear blend between neighbours when a column
 * covers less than one peak, so the outline stays smooth at any zoom.
 */
function columnAmplitudes(peaks, duration, from, to, columns) {
  const perSecond = peaks.length / duration;
  if (!Number.isFinite(perSecond)) return new Float32Array(columns);
  const step = ((to - from) * perSecond) / columns;
  const amplitudes = new Float32Array(columns);

  for (let column = 0; column < columns; column += 1) {
    const start = (from + ((to - from) * column) / columns) * perSecond;
    if (step < 1) {
      const left = Math.floor(start);
      const blend = start - left;
      const a = peaks[Math.min(left, peaks.length - 1)] ?? 0;
      const b = peaks[Math.min(left + 1, peaks.length - 1)] ?? a;
      amplitudes[column] = a + (b - a) * blend;
      continue;
    }
    let max = 0;
    const end = Math.min(Math.ceil(start + step), peaks.length);
    for (let index = Math.max(Math.floor(start), 0); index < end; index += 1) {
      if (peaks[index] > max) max = peaks[index];
    }
    amplitudes[column] = max;
  }
  return amplitudes;
}

/** Bass, mids and treble of a column mixed into one colour. */
function columnColour(low, mid, high) {
  const loudest = Math.max(low, mid, high, 0.0001);
  const red = Math.round(80 + 175 * (low / loudest));
  const green = Math.round(80 + 175 * (mid / loudest));
  const blue = Math.round(80 + 175 * (high / loudest));
  return `rgb(${red}, ${green}, ${blue})`;
}

/** Mirror the amplitudes around the centre line, one coloured column at a time. */
function drawWaveform(context, columns, width, height) {
  const middle = height / 2;
  const count = columns.amplitude.length;
  const columnWidth = width / count;

  for (let column = 0; column < count; column += 1) {
    const amplitude = Math.max(columns.amplitude[column] * (middle - 2), 0.75);
    context.fillStyle = columns.low
      ? columnColour(columns.low[column], columns.mid[column], columns.high[column])
      : '#22d3ee';
    context.fillRect(column * columnWidth, middle - amplitude, columnWidth + 0.5, amplitude * 2);
  }
}

/**
 * Beat times inside [from, to], stepping with the tempo of each map section so
 * the grid follows tempo changes. The beat clock carries over each boundary,
 * so a tempo change lands on the next beat rather than mid-bar.
 */
function beatsInRange(beat, from, to) {
  const map = beat.map?.length > 0 ? beat.map : [{ start: 0, bpm: beat.bpm }];
  const beats = [];
  let time = beat.offset;
  let index = 0;
  for (let seg = 0; seg < map.length; seg += 1) {
    const period = 60 / map[seg].bpm;
    const end = map[seg + 1]?.start ?? Infinity;
    while (time < end) {
      if (time > to) return beats;
      if (time >= from) beats.push({ time, index });
      time += period;
      index += 1;
    }
  }
  return beats;
}

/**
 * Beat ticks every 60/bpm seconds, with a taller line and a bar number on each
 * bar (4 beats). Numbers are dropped when bars are too close to read.
 */
function drawBeatGrid(context, beat, width, height, from, to) {
  if (!beat || to <= from) return;
  const barSpacing = (((60 / beat.bpm) * 4) / (to - from)) * width;
  const numbered = barSpacing >= 34;

  context.font = '10px system-ui, sans-serif';
  context.textBaseline = 'top';

  for (const { time, index } of beatsInRange(beat, from, to)) {
    const x = ((time - from) / (to - from)) * width;
    const downbeat = index % 4 === 0;
    context.strokeStyle = downbeat ? 'rgba(226, 232, 240, 0.55)' : 'rgba(148, 163, 184, 0.22)';
    context.beginPath();
    context.moveTo(x, downbeat ? 0 : height * 0.12);
    context.lineTo(x, downbeat ? height : height * 0.88);
    context.stroke();
    if (downbeat && numbered) {
      context.fillStyle = 'rgba(226, 232, 240, 0.75)';
      context.fillText(String(index / 4 + 1), x + 3, 2);
    }
  }
}

/** Visible slice of the track: all of it at zoom 1, otherwise centred on the playhead. */
function windowFor(progress, duration, zoom) {
  const span = duration / zoom;
  const from = Math.min(Math.max(progress - span / 2, 0), Math.max(duration - span, 0));
  return { from, to: from + span };
}

/**
 * Waveform and beat grid of a stretch of the track, drawn once into an
 * offscreen canvas at screen resolution. It spans more than the visible window
 * so that following the playhead only has to blit a moving slice of it.
 */
function renderCache(previous, { peaks, beat, duration, from, to, width, height, ratio }) {
  const span = to - from;
  const cacheSpan = Math.min(span * CACHE_SPANS, duration);
  const pixels = Math.min(Math.round(((width * ratio) / span) * cacheSpan), MAX_CACHE_PIXELS);
  const pixelHeight = Math.round(height * ratio);
  const usable =
    previous &&
    previous.peaks === peaks &&
    previous.beat === beat &&
    previous.duration === duration &&
    previous.canvas.width === pixels &&
    previous.canvas.height === pixelHeight &&
    previous.from <= from &&
    previous.to >= to;
  if (usable) return previous;

  const canvas = previous?.canvas ?? document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixelHeight;

  const start = Math.min(Math.max(from + span / 2 - cacheSpan / 2, 0), Math.max(duration - cacheSpan, 0));
  const end = start + cacheSpan;
  const scale = pixels / cacheSpan;

  // the peaks span the decoded audio, which can be a shade longer than the
  // element reports; mapping through their own duration keeps them in time
  const peakDuration = Number.isFinite(peaks.duration) ? peaks.duration : duration;
  const columns = Math.round(pixels / ratio);
  const band = (values) => (values ? columnAmplitudes(values, peakDuration, start, end, columns) : null);

  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, columns, height);
  drawBeatGrid(context, beat, columns, height, start, end);
  drawWaveform(
    context,
    {
      amplitude: columnAmplitudes(peaks.peak, peakDuration, start, end, columns),
      low: band(peaks.low),
      mid: band(peaks.mid),
      high: band(peaks.high)
    },
    columns,
    height
  );

  return { canvas, peaks, beat, duration, from: start, to: end, scale };
}

function Waveform({ peaks, beat, audioRef, progress, duration, zoom, loading, silent, onSeek, onZoom }) {
  const canvasRef = useRef(null);
  const cacheRef = useRef(null);
  const windowRef = useRef({ from: 0, to: 0 });
  const inputRef = useRef(null);
  inputRef.current = { peaks, beat, duration, zoom, progress };

  // the playhead is read straight from the audio element every frame, so the
  // drawing follows the sound instead of React state updates
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    cacheRef.current = null;
    let frame = 0;
    let drawn = null;

    const render = () => {
      frame = requestAnimationFrame(render);
      const { peaks: current, beat: grid, duration: length, zoom: level, progress: fallback } = inputRef.current;
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 120;
      const ratio = window.devicePixelRatio || 1;
      const time = audioRef?.current ? audioRef.current.currentTime : fallback;
      const resized = canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio);
      if (resized) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        cacheRef.current = null;
      }
      const state = { time, width, height, ratio, length, level, peaks: current, beat: grid };
      if (drawn && Object.keys(state).every((key) => state[key] === drawn[key])) return;
      drawn = state;

      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (!current?.peak?.length || !length) {
        context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        context.beginPath();
        context.moveTo(0, height / 2);
        context.lineTo(width, height / 2);
        context.stroke();
        return;
      }

      const { from, to } = windowFor(time, length, level);
      windowRef.current = { from, to };
      const cache = renderCache(cacheRef.current, {
        peaks: current,
        beat: grid,
        duration: length,
        from,
        to,
        width,
        height,
        ratio
      });
      cacheRef.current = cache;

      const sx = (from - cache.from) * cache.scale;
      const sw = (to - from) * cache.scale;
      context.globalAlpha = UNPLAYED_ALPHA;
      context.drawImage(cache.canvas, sx, 0, sw, cache.canvas.height, 0, 0, width, height);
      context.globalAlpha = 1;

      const played = Math.min(Math.max((time - from) / (to - from), 0), 1);
      if (played > 0) {
        context.drawImage(cache.canvas, sx, 0, sw * played, cache.canvas.height, 0, 0, width * played, height);
      }

      const playhead = played * width;
      context.strokeStyle = 'rgba(34, 211, 238, 0.9)';
      context.beginPath();
      context.moveTo(playhead, 0);
      context.lineTo(playhead, height);
      context.stroke();
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [audioRef]);

  return (
    <div className="waveform">
      <canvas
        ref={canvasRef}
        onClick={(event) => {
          if (!duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const { from, to } = windowRef.current;
          if (to <= from) return;
          onSeek(from + ((event.clientX - rect.left) / rect.width) * (to - from));
        }}
        onWheel={(event) => {
          if (!duration) return;
          onZoom(event.deltaY < 0 ? zoom * 1.2 : zoom / 1.2);
        }}
      />
      {loading && <span className="waveform-note">reading waveform…</span>}
      {!loading && silent && <span className="waveform-note">every stem is muted</span>}
      {!loading && !silent && !peaks && (
        <span className="waveform-note">waveform appears when a track is loaded</span>
      )}
    </div>
  );
}

export default function Music() {
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [currentId, setCurrentId] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ time: 0, duration: 0 });
  const [volume, setVolume] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState('off');
  const [search, setSearch] = useState('');
  const [peaks, setPeaks] = useState(null);
  const [peaksLoading, setPeaksLoading] = useState(false);
  const [bpm, setBpm] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [stems, setStems] = useState({ state: 'idle', progress: 0, stems: [] });
  const [stemsRun, setStemsRun] = useState(0);
  const [mix, setMix] = useState({});
  const [stemPeaks, setStemPeaks] = useState(null);
  const [stemPeaksLoading, setStemPeaksLoading] = useState(false);
  const [playlists, setPlaylists] = useState([]);
  const [playlistId, setPlaylistId] = useState(null);
  const [playlistName, setPlaylistName] = useState('');
  const [rowSize, setRowSize] = useState(() => localStorage.getItem('music.rowSize') || 'normal');
  const [library, setLibrary] = useState({ available: false, tracks: {} });
  const [queueing, setQueueing] = useState(false);
  const audioRef = useRef(null);
  const fileRef = useRef(null);
  const stemRefs = useRef({});
  const currentRef = useRef(null);
  const currentIdRef = useRef(null);
  const stemsRef = useRef(stems);
  const pendingTempo = useRef(false);

  const separated = stems.state === 'done' && stems.stems.length > 0;

  /** How loud each stem is in the current mix, mirroring what the elements play. */
  const weights = useMemo(() => {
    const soloed = stems.stems.filter((name) => mix[name]?.solo);
    return Object.fromEntries(
      stems.stems.map((name) => {
        const settings = mix[name] ?? {};
        const audible = soloed.length > 0 ? Boolean(settings.solo) : !settings.muted;
        return [name, audible ? (settings.gain ?? 1) : 0];
      })
    );
  }, [stems.stems, mix]);

  // the waveform follows the mix: only the audible stems, at their fader level
  const mixedPeaks = useMemo(() => {
    if (!stemPeaks) return null;
    const entries = Object.entries(stemPeaks).map(([name, analysis]) => [analysis, weights[name] ?? 0]);
    return mixWaveforms(entries);
  }, [stemPeaks, weights]);

  const audibleStems = stems.stems.filter((name) => (weights[name] ?? 0) > 0);
  const silent = Boolean(stemPeaks) && !mixedPeaks;
  const shownPeaks = stemPeaks ? mixedPeaks : peaks;

  useEffect(() => {
    if (!playing) return undefined;
    let shown = -1;
    let frame = requestAnimationFrame(function tick() {
      const audio = audioRef.current;
      if (audio) {
        // the waveform reads the element itself, so the clock and the scrubber
        // only need a few updates a second
        if (Math.abs(audio.currentTime - shown) >= 0.2) {
          shown = audio.currentTime;
          setProgress({ time: audio.currentTime, duration: audio.duration || 0 });
        }
        // the mix is played by one element per stem, kept on the main clock
        for (const stem of Object.values(stemRefs.current)) {
          if (!stem) continue;
          if (Math.abs(stem.currentTime - audio.currentTime) > 0.08) {
            stem.currentTime = audio.currentTime;
          }
          // seeking can interrupt a pending play(), leaving one stem behind
          if (stem.paused && !audio.paused) stem.play().catch(() => {});
        }
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // stem elements follow the transport and the per-stem faders
  useEffect(() => {
    const soloed = stems.stems.filter((stem) => mix[stem]?.solo);
    for (const name of stems.stems) {
      const element = stemRefs.current[name];
      if (!element) continue;
      const settings = mix[name] ?? {};
      const audible = soloed.length > 0 ? settings.solo : !settings.muted;
      element.volume = audible ? volume * (settings.gain ?? 1) : 0;
      if (playing) element.play().catch(() => {});
      else element.pause();
    }
    if (audioRef.current) audioRef.current.muted = separated;
  }, [mix, stems, playing, volume, separated, currentId]);

  // poll while the separation job runs
  useEffect(() => {
    if (!currentId || stems.state !== 'running') return undefined;
    const timer = setInterval(() => {
      api
        .get(`/music/tracks/${currentId}/stems`)
        .then(setStems)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [currentId, stems.state]);

  const separate = async () => {
    if (!currentId) return;
    try {
      const job = await api.post(`/music/tracks/${currentId}/stems`, {});
      // a new run produces new files under the same URLs, so bust the cache
      setStemsRun((run) => run + 1);
      setStems({ state: 'running', progress: 0, stems: [], id: job.id });
    } catch (err) {
      setError(err.message);
    }
  };

  const setStemSetting = (name, patch) =>
    setMix((current) => ({ ...current, [name]: { gain: 1, ...current[name], ...patch } }));

  /**
   * Fold a fresh tempo reading into what is stored: a manually corrected or
   * drums-derived BPM is trusted and only takes the beat offset, a full-mix
   * guess is replaced by anything better, and the tempo map is stored so the
   * beat grid can follow tempo changes inside the track.
   */
  const applyTempo = async (tempo, source, trackId) => {
    if (!tempo || currentIdRef.current !== trackId) return;
    const track = currentRef.current;
    const keep = track?.bpm && track?.bpmSource !== 'mix';
    if (keep && source === 'mix' && track?.bpmSource === 'drums') return;

    // a fresh map only rides along with a trusted tempo when it agrees with it
    const map = keep
      ? track.bpmMap ??
        (tempo.map && Math.abs(tempo.bpm - track.bpm) / track.bpm < 0.03 ? tempo.map : null)
      : tempo.map ?? null;
    setBpm({ bpm: keep ? track.bpm : tempo.bpm, offset: tempo.offset, map });

    const patch = {};
    if (!keep) {
      patch.bpm = tempo.bpm;
      patch.bpmSource = source;
      if (map) patch.bpmMap = map;
    } else if (!track.bpmMap && map) {
      patch.bpmMap = map;
    }
    if (Object.keys(patch).length === 0) return;
    try {
      const updated = await api.patch(`/music/tracks/${trackId}`, patch);
      setTracks((entries) => entries.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setError(err.message);
    }
  };

  /** Detect the tempo off the isolated drums stem, or the full mix when there are no stems yet. */
  const detectTempo = async () => {
    const trackId = currentIdRef.current;
    if (!trackId) return;
    setAnalysing(true);
    let context;
    try {
      const drums = stemsRef.current.stems?.includes('drums');
      const url = drums
        ? `${BASE}/music/tracks/${trackId}/stems/drums/stream?v=${stemsRun}`
        : `${BASE}/music/tracks/${trackId}/stream`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not read ${drums ? 'the drums stem' : 'the track'}`);
      context = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      await applyTempo(await detectBpm(decoded), drums ? 'drums' : 'mix', trackId);
    } catch (err) {
      if (currentIdRef.current === trackId) setError(`BPM detection failed: ${err.message}`);
    } finally {
      context?.close();
      if (currentIdRef.current === trackId) setAnalysing(false);
    }
  };

  /** One click: separate the stems if needed, then read the tempo off the drums. */
  const analyse = async (force = false) => {
    if (!currentId) return;
    setError(null);
    if (separated && !force) {
      pendingTempo.current = false;
      await detectTempo();
      return;
    }
    pendingTempo.current = true;
    await separate();
  };

  const load = () => api.get('/music/tracks').then(setTracks).catch((err) => setError(err.message));
  const loadPlaylists = () => api.get('/music/playlists').then(setPlaylists).catch(() => {});

  useEffect(() => {
    load();
    loadPlaylists();
  }, []);

  useEffect(() => localStorage.setItem('music.rowSize', rowSize), [rowSize]);

  // separation state of every track, so rows show it and "Analyze all" can report progress
  const loadLibraryStems = useCallback(
    () => api.get('/music/stems/library').then(setLibrary).catch(() => {}),
    []
  );

  useEffect(() => {
    loadLibraryStems();
    const timer = setInterval(loadLibraryStems, 5000);
    return () => clearInterval(timer);
  }, [loadLibraryStems]);

  const playlist = playlists.find((entry) => entry.id === playlistId) ?? null;

  const visible = useMemo(() => {
    const inPlaylist = playlist
      ? playlist.trackIds
          .map((id) => tracks.find((track) => track.id === id))
          .filter(Boolean)
      : tracks;
    const needle = search.trim().toLowerCase();
    if (!needle) return inPlaylist;
    return inPlaylist.filter((track) =>
      `${track.title} ${track.artist} ${track.album || ''}`.toLowerCase().includes(needle)
    );
  }, [tracks, playlist, search]);

  const pending = visible.filter((track) => library.tracks[track.id]?.state !== 'done');

  const createPlaylist = async () => {
    const name = playlistName.trim();
    if (!name) return;
    try {
      const created = await api.post('/music/playlists', { name });
      setPlaylists((current) => [created, ...current]);
      setPlaylistName('');
      setPlaylistId(created.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const removePlaylist = async (entry) => {
    try {
      await api.remove(`/music/playlists/${entry.id}`);
      setPlaylists((current) => current.filter((item) => item.id !== entry.id));
      if (entry.id === playlistId) setPlaylistId(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const addToPlaylist = async (targetId, trackId) => {
    try {
      const updated = await api.post(`/music/playlists/${targetId}/tracks`, { trackId });
      setPlaylists((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setError(err.message);
    }
  };

  const removeFromPlaylist = async (trackId) => {
    if (!playlist) return;
    try {
      const updated = await api.remove(`/music/playlists/${playlist.id}/tracks/${trackId}`);
      setPlaylists((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setError(err.message);
    }
  };

  /** Queue every track that has no stems yet; the service separates them one by one. */
  const analyseAll = async () => {
    setQueueing(true);
    setError(null);
    let failed = 0;
    let queued = 0;
    for (const track of pending) {
      if (library.tracks[track.id]?.state === 'running') continue;
      queued += 1;
      try {
        await api.post(`/music/tracks/${track.id}/stems`, {});
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) setError(`${failed} of ${queued} tracks could not be queued`);
    await loadLibraryStems();
    setQueueing(false);
  };

  /** Re-run separation on every listed track, including ones already analyzed. */
  const reanalyseAll = async () => {
    setQueueing(true);
    setError(null);
    let failed = 0;
    let queued = 0;
    for (const track of visible) {
      if (library.tracks[track.id]?.state === 'running') continue;
      queued += 1;
      try {
        const job = await api.post(`/music/tracks/${track.id}/stems`, {});
        if (track.id === currentId) {
          pendingTempo.current = true;
          setStemsRun((run) => run + 1);
          setStems({ state: 'running', progress: 0, stems: [], id: job.id });
        }
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) setError(`${failed} of ${queued} tracks could not be queued`);
    await loadLibraryStems();
    setQueueing(false);
  };

  const current = tracks.find((track) => track.id === currentId) ?? null;

  useEffect(() => {
    currentRef.current = current;
    currentIdRef.current = current?.id ?? null;
  }, [current]);

  useEffect(() => {
    stemsRef.current = stems;
  }, [stems]);

  const play = (track) => {
    if (track.id === currentId) {
      const audio = audioRef.current;
      if (audio?.paused) audio.play();
      else audio?.pause();
      return;
    }
    setCurrentId(track.id);
    setPlaying(true);
  };

  const step = (offset) => {
    if (visible.length === 0) return;
    if (shuffle) {
      const pool = visible.filter((track) => track.id !== currentId);
      const next = pool[Math.floor(Math.random() * pool.length)] ?? visible[0];
      setCurrentId(next.id);
      setPlaying(true);
      return;
    }
    const index = visible.findIndex((track) => track.id === currentId);
    const next = visible[(index + offset + visible.length) % visible.length];
    if (next) {
      setCurrentId(next.id);
      setPlaying(true);
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentId) return;
    // a leftover position from the previous track would scroll the waveform
    // away from the start of this one
    setProgress({ time: 0, duration: 0 });
    audio.load();
    if (playing) audio.play().catch(() => setPlaying(false));
  }, [currentId]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, currentId]);

  // each stem gets its own envelope so the waveform can be re-mixed instantly
  const stemNames = stems.stems.join(',');
  useEffect(() => {
    if (!separated || !currentId) return undefined;
    const names = stemNames.split(',');
    let cancelled = false;
    const controller = new AbortController();
    setStemPeaksLoading(true);

    (async () => {
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      try {
        const analysed = {};
        for (const name of names) {
          const response = await fetch(
            `${BASE}/music/tracks/${currentId}/stems/${name}/stream?v=${stemsRun}`,
            { signal: controller.signal }
          );
          const decoded = await context.decodeAudioData(await response.arrayBuffer());
          if (cancelled) return;
          analysed[name] = await analyseWaveform(decoded, { normalised: false });
        }
        if (!cancelled) setStemPeaks(analysed);
      } catch {
        if (!cancelled) setStemPeaks(null);
      } finally {
        context.close();
        if (!cancelled) setStemPeaksLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [separated, currentId, stemNames, stemsRun]);

  useEffect(() => {
    if (!currentId) return;
    setStems({ state: 'idle', progress: 0, stems: [] });
    setMix({});
    setStemPeaks(null);
    stemRefs.current = {};
    pendingTempo.current = false;
    api
      .get(`/music/tracks/${currentId}/stems`)
      .then(setStems)
      .catch(() => {});
  }, [currentId]);

  useEffect(() => {
    setPeaks(null);
    setBpm(null);
    setZoom(1);
    if (!currentId) return undefined;

    let cancelled = false;
    const controller = new AbortController();
    setPeaksLoading(true);
    setAnalysing(true);

    (async () => {
      let context;
      try {
        const response = await fetch(`${BASE}/music/tracks/${currentId}/stream`, { signal: controller.signal });
        const bytes = await response.arrayBuffer();
        context = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await context.decodeAudioData(bytes);
        if (cancelled) return;
        const analysed = await analyseWaveform(decoded);
        if (cancelled) return;
        setPeaks(analysed);
        setPeaksLoading(false);

        // when the drums are already separated they give a much cleaner
        // reading, and that pass runs in the stems effect instead
        const stemsReady =
          stemsRef.current.state === 'done' && stemsRef.current.stems?.includes('drums');
        if (!stemsReady) {
          const tempo = await detectBpm(decoded);
          if (cancelled) return;
          await applyTempo(tempo, 'mix', currentId);
        }
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') setPeaks(null);
      } finally {
        context?.close();
        if (!cancelled) {
          setPeaksLoading(false);
          setAnalysing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [currentId]);

  // once the stems land, the drums give a cleaner reading than the full mix:
  // run it after an Analyze click, and to replace a tempo guessed on the mix
  const bpmSource = current?.bpmSource;
  useEffect(() => {
    if (!currentId || !separated || !stems.stems.includes('drums')) return;
    if (pendingTempo.current || bpmSource === 'mix' || (!bpmSource && !current?.bpm)) {
      pendingTempo.current = false;
      detectTempo();
    }
  }, [currentId, separated, bpmSource, stemNames]);

  const uploadFiles = useCallback(async (files) => {
    if (!files || files.length === 0) {
      setError('Pick at least one audio file.');
      return;
    }
    const form = new FormData();
    for (const file of files) form.append('files', file);

    setUploading(true);
    setError(null);
    try {
      const response = await fetch(`${BASE}/music/tracks`, { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `Upload failed (${response.status})`);
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }, []);

  const removeTrack = async (track) => {
    try {
      await api.remove(`/music/tracks/${track.id}`);
      if (track.id === currentId) {
        setCurrentId(null);
        setPlaying(false);
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const rename = async (track, field, value) => {
    if (value === track[field]) return;
    try {
      const updated = await api.patch(`/music/tracks/${track.id}`, { [field]: value });
      setTracks((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setError(err.message);
    }
  };

  const tempo = bpm?.bpm ?? current?.bpm ?? null;
  const tempoMapRange =
    bpm?.map?.length > 1
      ? [Math.min(...bpm.map.map((seg) => seg.bpm)), Math.max(...bpm.map.map((seg) => seg.bpm))].map(
          Math.round
        )
      : null;
  const tempoLabel = tempoMapRange
    ? `${tempoMapRange[0]}–${tempoMapRange[1]} BPM`
    : tempo
      ? `${tempo} BPM`
      : current
        ? analysing
          ? 'detecting BPM…'
          : 'no steady beat'
        : 'BPM —';

  const changeZoom = (next) => setZoom(Math.min(Math.max(next, 1), MAX_ZOOM));

  /** Half and double a tempo fit the same beats, so let the reading be corrected. */
  const scaleTempo = async (factor) => {
    if (!tempo || !currentId) return;
    const scaled = Math.round(tempo * factor * 10) / 10;
    const scaledMap =
      (bpm?.map ?? current?.bpmMap)?.map((seg) => ({
        ...seg,
        bpm: Math.round(seg.bpm * factor * 10) / 10
      })) ?? null;
    setBpm((beat) => ({ ...(beat ?? { offset: 0 }), bpm: scaled, map: scaledMap }));
    try {
      const updated = await api.patch(`/music/tracks/${currentId}`, {
        bpm: scaled,
        bpmSource: 'manual',
        ...(scaledMap ? { bpmMap: scaledMap } : {})
      });
      setTracks((entries) => entries.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (err) {
      setError(err.message);
    }
  };

  const seek = (seconds) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    setProgress((current) => ({ ...current, time: seconds }));
  };

  return (
    <Page
      title="Music"
      subtitle="Your own library, streamed from the dashboard API."
      actions={current && <span className="muted">{playing ? 'playing' : 'paused'}</span>}
    >
      <ErrorBanner message={error} />

      <div
        className={dragging ? 'dropzone slim dragging' : 'dropzone slim'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          uploadFiles(event.dataTransfer.files);
        }}
      >
        <span className="drop-glyph">♫</span>
        <span className="muted">{uploading ? 'uploading…' : 'Drop audio files here'}</span>
        <button type="button" className="pill" onClick={() => fileRef.current?.click()}>
          Choose files
        </button>
        <input
          type="file"
          className="hidden-input"
          accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav"
          multiple
          ref={fileRef}
          onChange={(event) => uploadFiles(event.target.files)}
        />
      </div>

      <Card className="player">
        <div className="form-stack">
          <audio
            ref={audioRef}
            src={current ? `${BASE}/music/tracks/${current.id}/stream` : undefined}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => setProgress({ time: event.target.currentTime, duration: event.target.duration || 0 })}
            onLoadedMetadata={(event) => setProgress({ time: 0, duration: event.target.duration || 0 })}
            onEnded={() => {
              if (repeat === 'one') {
                audioRef.current.currentTime = 0;
                audioRef.current.play();
              } else if (repeat === 'all' || shuffle) {
                step(1);
              } else {
                setPlaying(false);
              }
            }}
          />

          <div className="player-head">
            {current?.cover ? (
              <img className="cover" src={`${BASE}/music/tracks/${current.id}/cover`} alt="" />
            ) : (
              <div className="cover cover-empty">♫</div>
            )}
            <div className="player-meta">
              <h2 className="player-title">{current ? current.title : 'Nothing playing'}</h2>
              <p className="muted player-sub">
                {current ? [current.artist, current.album].filter(Boolean).join(' · ') || 'unknown artist' : 'pick a track from the library'}
              </p>
              <div className="chips">
                <span className="chip">{tempoLabel}</span>
                <button
                  type="button"
                  className="chip tap"
                  onClick={detectTempo}
                  disabled={!current || analysing}
                  title={separated ? 're-detect BPM from the drums stem' : 're-detect BPM from the full mix'}
                >
                  ↺
                </button>
                <button type="button" className="chip tap" onClick={() => scaleTempo(0.5)} disabled={!tempo}>
                  ÷2
                </button>
                <button type="button" className="chip tap" onClick={() => scaleTempo(2)} disabled={!tempo}>
                  ×2
                </button>
                <span className="chip ghost-chip">
                  {zoom > 1 ? `${zoom.toFixed(1).replace(/\.0$/, '')}×` : '1×'}
                </span>
                <button type="button" className="chip tap" onClick={() => changeZoom(zoom / 2)} disabled={!current || zoom <= 1}>
                  −
                </button>
                <button type="button" className="chip tap" onClick={() => changeZoom(zoom * 2)} disabled={!current || zoom >= MAX_ZOOM}>
                  +
                </button>
                {stemPeaks && (
                  <span className="chip ghost-chip">
                    wave: {audibleStems.length > 0 ? audibleStems.join(' + ') : 'silent'}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="player-wave">
            <Waveform
              peaks={shownPeaks}
              beat={bpm}
              audioRef={audioRef}
              progress={progress.time}
              duration={progress.duration}
              zoom={zoom}
              loading={peaksLoading || stemPeaksLoading}
              silent={silent}
              onSeek={seek}
              onZoom={changeZoom}
            />
          </div>

          <div className="transport">
            <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={!current} title="previous">
              ◀◀
            </button>
            <button
              type="button"
              className="icon-btn primary"
              onClick={() => current && play(current)}
              disabled={!current}
              title={playing ? 'pause' : 'play'}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <button type="button" className="icon-btn" onClick={() => step(1)} disabled={!current} title="next">
              ▶▶
            </button>
            <span className="time">{clock(progress.time)}</span>
            <input
              className="scrub"
              type="range"
              min="0"
              max={progress.duration || 0}
              step="0.5"
              value={progress.time}
              disabled={!current}
              onChange={(event) => seek(Number(event.target.value))}
            />
            <span className="time muted">{clock(progress.duration)}</span>
            <button
              type="button"
              className={shuffle ? 'icon-btn on' : 'icon-btn'}
              onClick={() => setShuffle(!shuffle)}
              title="shuffle"
            >
              ⇄
            </button>
            <button
              type="button"
              className={repeat === 'off' ? 'icon-btn' : 'icon-btn on'}
              onClick={() => setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')}
              title={`repeat: ${repeat}`}
            >
              {repeat === 'one' ? '↻1' : '↻'}
            </button>
            <span className="icon-btn flat" title="volume">
              ♪
            </span>
            <input
              className="vol"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </div>

          <div className="row stems-row">
            {separated ? (
              <>
              {stems.stems.map((name) => {
                const settings = mix[name] ?? {};
                return (
                  <span key={name} className="stem">
                    <button
                      type="button"
                      className={settings.muted ? 'tab' : 'tab active'}
                      onClick={() => setStemSetting(name, { muted: !settings.muted })}
                    >
                      {name}
                    </button>
                    <button
                      type="button"
                      className={settings.solo ? 'tab active' : 'tab'}
                      onClick={() => setStemSetting(name, { solo: !settings.solo })}
                    >
                      solo
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={settings.gain ?? 1}
                      onChange={(event) => setStemSetting(name, { gain: Number(event.target.value) })}
                    />
                    <audio
                      ref={(element) => {
                        if (element) stemRefs.current[name] = element;
                        else delete stemRefs.current[name];
                      }}
                      preload="auto"
                      src={`${BASE}/music/tracks/${currentId}/stems/${name}/stream?v=${stemsRun}`}
                    />
                  </span>
                );
              })}
              <button
                type="button"
                className="ghost"
                onClick={() => analyse(true)}
                disabled={analysing}
                title="separate again and re-detect the BPM from the drums"
              >
                re-analyze
              </button>
              {stems.error ? <span className="muted">last run failed: {stems.error}</span> : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="pill"
                  onClick={() => analyse()}
                  disabled={!current || stems.state === 'running' || analysing}
                >
                  {stems.state === 'running' ? 'analyzing…' : analysing ? 'detecting BPM…' : 'Analyze'}
                </button>
                <span className="muted">
                  {stems.state === 'running'
                    ? `${Math.round((stems.progress || 0) * 100)}% — separating stems, then BPM from the drums`
                    : stems.state === 'failed'
                      ? `separation failed: ${stems.error}`
                      : 'separate the stems, then detect the BPM on the drums'}
                </span>
              </>
            )}
          </div>

        </div>
      </Card>

      <Card className="playlists" title={`Playlists (${playlists.length})`}>
        <div className="row">
          <button type="button" className={playlistId ? 'tab' : 'tab active'} onClick={() => setPlaylistId(null)}>
            All tracks ({tracks.length})
          </button>
          {playlists.map((entry) => (
            <span key={entry.id} className="stem">
              <button
                type="button"
                className={entry.id === playlistId ? 'tab active' : 'tab'}
                onClick={() => setPlaylistId(entry.id)}
              >
                {entry.name} ({entry.trackIds.length})
              </button>
              <button type="button" className="ghost" onClick={() => removePlaylist(entry)}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <input
            placeholder="New playlist name"
            value={playlistName}
            onChange={(event) => setPlaylistName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && createPlaylist()}
          />
          <button type="button" onClick={createPlaylist} disabled={!playlistName.trim()}>
            Create playlist
          </button>
        </div>
      </Card>

      <Card className="library" title={playlist ? `${playlist.name} (${visible.length})` : `Library (${tracks.length})`}>
        <div className="row toolbar">
          <input
            className="grow"
            placeholder="Search title, artist or album"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="muted">rows</span>
          {ROW_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={rowSize === size ? 'tab active' : 'tab'}
              onClick={() => setRowSize(size)}
            >
              {size}
            </button>
          ))}
          <button type="button" className="pill" onClick={analyseAll} disabled={queueing || pending.length === 0}>
            {queueing ? 'queueing…' : `${playlist ? 'Analyze playlist' : 'Analyze all'} (${pending.length})`}
          </button>
          <button
            type="button"
            className="pill"
            onClick={reanalyseAll}
            disabled={queueing || !library.available || visible.length === 0}
            title="re-run stem separation for every listed track, including ones already analyzed"
          >
            Re-run all
          </button>
          <span className="muted">
            {library.available
              ? `${visible.length - pending.length}/${visible.length} separated`
              : 'stem service offline'}
          </span>
        </div>
        {visible.length === 0 ? (
          <EmptyState>
            {tracks.length === 0
              ? 'No tracks yet — drop some audio files above.'
              : playlist
                ? 'This playlist is empty — add tracks from the library.'
                : 'Nothing matches that search.'}
          </EmptyState>
        ) : (
          <ul className={`list tracklist ${rowSize}`}>
            {visible.map((track) => {
              const state = library.tracks[track.id] ?? { state: 'idle', progress: 0 };
              return (
                <li key={track.id} className={track.id === currentId ? 'active' : undefined}>
                  <button type="button" className="icon-btn small" onClick={() => play(track)}>
                    {track.id === currentId && playing ? '❚❚' : '▶'}
                  </button>
                  {track.cover ? (
                    <img className="row-cover" src={`${BASE}/music/tracks/${track.id}/cover`} alt="" />
                  ) : (
                    <span className="row-cover cover-empty">♫</span>
                  )}
                  <input
                    value={track.title}
                    onChange={(event) =>
                      setTracks((current) =>
                        current.map((entry) => (entry.id === track.id ? { ...entry, title: event.target.value } : entry))
                      )
                    }
                    onBlur={(event) => rename(track, 'title', event.target.value)}
                  />
                  <input
                    placeholder="artist"
                    value={track.artist || ''}
                    onChange={(event) =>
                      setTracks((current) =>
                        current.map((entry) => (entry.id === track.id ? { ...entry, artist: event.target.value } : entry))
                      )
                    }
                    onBlur={(event) => rename(track, 'artist', event.target.value)}
                  />
                  {track.bpm ? <span className="chip ghost-chip">{track.bpm} BPM</span> : null}
                  {state.state === 'done' ? (
                    <span className="chip done-chip">stems</span>
                  ) : state.state === 'running' ? (
                    <span className="chip busy-chip">{Math.round((state.progress || 0) * 100)}%</span>
                  ) : state.state === 'failed' ? (
                    <span className="chip fail-chip">failed</span>
                  ) : null}
                  <span className="muted right">{(track.size / 1024 / 1024).toFixed(1)} MB</span>
                  {playlist ? (
                    <button type="button" className="ghost" onClick={() => removeFromPlaylist(track.id)}>
                      remove
                    </button>
                  ) : (
                    playlists.length > 0 && (
                      <select
                        value=""
                        onChange={(event) => event.target.value && addToPlaylist(event.target.value, track.id)}
                      >
                        <option value="">add to…</option>
                        {playlists.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </select>
                    )
                  )}
                  <button type="button" className="ghost" onClick={() => removeTrack(track)}>
                    delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Page>
  );
}
