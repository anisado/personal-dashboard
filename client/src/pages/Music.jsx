import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { detectBpm } from '../lib/bpm.js';
import { analyseWaveform } from '../lib/waveform.js';

const MAX_ZOOM = 32;
const ROW_SIZES = ['compact', 'normal', 'large'];

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
function columnColour(low, mid, high, played) {
  const loudest = Math.max(low, mid, high, 0.0001);
  const red = Math.round(80 + 175 * (low / loudest));
  const green = Math.round(80 + 175 * (mid / loudest));
  const blue = Math.round(80 + 175 * (high / loudest));
  return `rgba(${red}, ${green}, ${blue}, ${played ? 1 : 0.4})`;
}

/** Mirror the amplitudes around the centre line, one coloured column at a time. */
function drawWaveform(context, columns, width, height, playhead) {
  const middle = height / 2;
  const count = columns.amplitude.length;
  const columnWidth = width / count;

  for (let column = 0; column < count; column += 1) {
    const amplitude = Math.max(columns.amplitude[column] * (middle - 2), 0.75);
    const x = column * columnWidth;
    context.fillStyle = columns.low
      ? columnColour(columns.low[column], columns.mid[column], columns.high[column], x <= playhead)
      : x <= playhead
        ? '#22d3ee'
        : 'rgba(148, 163, 184, 0.45)';
    context.fillRect(x, middle - amplitude, columnWidth + 0.5, amplitude * 2);
  }
}

/**
 * Beat ticks every 60/bpm seconds, with a taller line and a bar number on each
 * bar (4 beats). Numbers are dropped when bars are too close to read.
 */
function drawBeatGrid(context, beat, width, height, from, to) {
  if (!beat || to <= from) return;
  const period = 60 / beat.bpm;
  const phase = beat.offset % period;
  const barSpacing = ((period * 4) / (to - from)) * width;
  const numbered = barSpacing >= 34;

  context.font = '10px system-ui, sans-serif';
  context.textBaseline = 'top';

  for (let index = Math.max(Math.ceil((from - phase) / period), 0); ; index += 1) {
    const time = phase + index * period;
    if (time > to) break;
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

function Waveform({ peaks, beat, progress, duration, zoom, loading, onSeek, onZoom }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 120;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;

    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const middle = height / 2;

    if (!peaks?.peak?.length || !duration) {
      context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      context.beginPath();
      context.moveTo(0, middle);
      context.lineTo(width, middle);
      context.stroke();
      return;
    }

    const { from, to } = windowFor(progress, duration, zoom);
    drawBeatGrid(context, beat, width, height, from, to);

    const count = Math.round(width * ratio);
    const band = (values) => (values ? columnAmplitudes(values, duration, from, to, count) : null);
    const playhead = ((progress - from) / (to - from)) * width;
    drawWaveform(
      context,
      {
        amplitude: columnAmplitudes(peaks.peak, duration, from, to, count),
        low: band(peaks.low),
        mid: band(peaks.mid),
        high: band(peaks.high)
      },
      width,
      height,
      playhead
    );

    if (playhead >= 0 && playhead <= width) {
      context.strokeStyle = 'rgba(34, 211, 238, 0.9)';
      context.beginPath();
      context.moveTo(playhead, 0);
      context.lineTo(playhead, height);
      context.stroke();
    }
  }, [peaks, beat, progress, duration, zoom]);

  return (
    <div className="waveform">
      <canvas
        ref={canvasRef}
        onClick={(event) => {
          if (!duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const { from, to } = windowFor(progress, duration, zoom);
          onSeek(from + ((event.clientX - rect.left) / rect.width) * (to - from));
        }}
        onWheel={(event) => {
          if (!duration) return;
          onZoom(event.deltaY < 0 ? zoom * 1.2 : zoom / 1.2);
        }}
      />
      {loading && <span className="waveform-note">reading waveform…</span>}
      {!loading && !peaks && <span className="waveform-note">waveform appears when a track is loaded</span>}
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
  const [mix, setMix] = useState({});
  const [playlists, setPlaylists] = useState([]);
  const [playlistId, setPlaylistId] = useState(null);
  const [playlistName, setPlaylistName] = useState('');
  const [rowSize, setRowSize] = useState(() => localStorage.getItem('music.rowSize') || 'normal');
  const [library, setLibrary] = useState({ available: false, tracks: {} });
  const [queueing, setQueueing] = useState(false);
  const audioRef = useRef(null);
  const fileRef = useRef(null);
  const stemRefs = useRef({});

  const separated = stems.state === 'done' && stems.stems.length > 0;

  useEffect(() => {
    if (!playing) return undefined;
    let frame = requestAnimationFrame(function tick() {
      const audio = audioRef.current;
      if (audio) {
        setProgress({ time: audio.currentTime, duration: audio.duration || 0 });
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
      await api.post(`/music/tracks/${currentId}/stems`, {});
      setStems({ state: 'running', progress: 0, stems: [] });
    } catch (err) {
      setError(err.message);
    }
  };

  const setStemSetting = (name, patch) =>
    setMix((current) => ({ ...current, [name]: { gain: 1, ...current[name], ...patch } }));

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
    for (const track of pending) {
      try {
        await api.post(`/music/tracks/${track.id}/stems`, {});
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) setError(`${failed} of ${pending.length} tracks could not be queued`);
    await loadLibraryStems();
    setQueueing(false);
  };

  const current = tracks.find((track) => track.id === currentId) ?? null;

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
    audio.load();
    if (playing) audio.play().catch(() => setPlaying(false));
  }, [currentId]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, currentId]);

  useEffect(() => {
    if (!currentId) return;
    setStems({ state: 'idle', progress: 0, stems: [] });
    setMix({});
    stemRefs.current = {};
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

        const tempo = await detectBpm(decoded);
        if (cancelled) return;
        // a stored tempo may have been corrected by hand, so keep it and only
        // take the beat offset from this pass
        const saved = current?.bpm;
        setBpm(tempo && saved ? { ...tempo, bpm: saved } : tempo);
        if (tempo && !saved) {
          const updated = await api.patch(`/music/tracks/${currentId}`, { bpm: tempo.bpm });
          setTracks((entries) => entries.map((entry) => (entry.id === updated.id ? updated : entry)));
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
  const tempoLabel = tempo ? `${tempo} BPM` : current ? (analysing ? 'detecting BPM…' : 'no steady beat') : 'BPM —';

  const changeZoom = (next) => setZoom(Math.min(Math.max(next, 1), MAX_ZOOM));

  /** Half and double a tempo fit the same beats, so let the reading be corrected. */
  const scaleTempo = async (factor) => {
    if (!tempo || !currentId) return;
    const scaled = Math.round(tempo * factor * 10) / 10;
    setBpm((beat) => (beat ? { ...beat, bpm: scaled } : { bpm: scaled, offset: 0 }));
    try {
      const updated = await api.patch(`/music/tracks/${currentId}`, { bpm: scaled });
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
              </div>
            </div>
          </div>

          <div className="player-wave">
            <Waveform
              peaks={peaks}
              beat={bpm}
              progress={progress.time}
              duration={progress.duration}
              zoom={zoom}
              loading={peaksLoading}
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
              stems.stems.map((name) => {
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
                      src={`${BASE}/music/tracks/${currentId}/stems/${name}/stream`}
                    />
                  </span>
                );
              })
            ) : (
              <>
                <button type="button" className="pill" onClick={separate} disabled={!current || stems.state === 'running'}>
                  {stems.state === 'running' ? 'separating stems…' : 'Separate stems'}
                </button>
                <span className="muted">
                  {stems.state === 'running'
                    ? `${Math.round((stems.progress || 0) * 100)}% — vocals, drums, bass and the rest`
                    : stems.state === 'failed'
                      ? `separation failed: ${stems.error}`
                      : 'split the track into vocals, drums, bass and other'}
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
