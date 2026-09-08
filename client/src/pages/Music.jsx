import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';
import { detectBpm } from '../lib/bpm.js';
import { analyseWaveform } from '../lib/waveform.js';

const MAX_ZOOM = 32;

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
  const audioRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = requestAnimationFrame(function tick() {
      const audio = audioRef.current;
      if (audio) setProgress({ time: audio.currentTime, duration: audio.duration || 0 });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const load = () => api.get('/music/tracks').then(setTracks).catch((err) => setError(err.message));

  useEffect(() => {
    load();
  }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.filter((track) => `${track.title} ${track.artist} ${track.album || ''}`.toLowerCase().includes(needle));
  }, [tracks, search]);

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
        className={dragging ? 'dropzone dragging' : 'dropzone'}
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
        <p>{uploading ? 'uploading…' : 'Drop audio files here'}</p>
        <div className="row">
          <input
            type="file"
            accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav"
            multiple
            ref={fileRef}
            onChange={(event) => uploadFiles(event.target.files)}
          />
        </div>
      </div>

      <Card title={current ? `${current.title}${current.artist ? ` — ${current.artist}` : ''}` : 'Nothing playing'}>
        <div className="form-stack">
          <div className="row">
            <span className="tag">{tempoLabel}</span>
            <button type="button" className="ghost" onClick={() => scaleTempo(0.5)} disabled={!tempo}>
              ÷2
            </button>
            <button type="button" className="ghost" onClick={() => scaleTempo(2)} disabled={!tempo}>
              ×2
            </button>
          </div>
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

          <div className="player-row">
            {current?.cover ? (
              <img className="cover" src={`${BASE}/music/tracks/${current.id}/cover`} alt="" />
            ) : (
              <div className="cover cover-empty">♫</div>
            )}
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

          <div className="row">
            <button type="button" onClick={() => changeZoom(zoom / 2)} disabled={!current || zoom <= 1}>
              − zoom
            </button>
            <button type="button" onClick={() => changeZoom(zoom * 2)} disabled={!current || zoom >= MAX_ZOOM}>
              + zoom
            </button>
            <span className="muted">
              {zoom > 1 ? `${zoom.toFixed(1).replace(/\.0$/, '')}× around the playhead` : 'whole track'}
            </span>
          </div>

          <div className="row">
            <button type="button" onClick={() => step(-1)} disabled={!current}>
              ◀◀ Prev
            </button>
            <button type="button" onClick={() => current && play(current)} disabled={!current}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button type="button" onClick={() => step(1)} disabled={!current}>
              Next ▶▶
            </button>
            <span className="muted">
              {clock(progress.time)} / {clock(progress.duration)}
            </span>
          </div>

          <input
            type="range"
            min="0"
            max={progress.duration || 0}
            step="0.5"
            value={progress.time}
            disabled={!current}
            onChange={(event) => seek(Number(event.target.value))}
          />

          <div className="row">
            <label className="row">
              <span className="muted">volume</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <button type="button" className={shuffle ? 'tab active' : 'tab'} onClick={() => setShuffle(!shuffle)}>
              shuffle
            </button>
            <button
              type="button"
              className="tab"
              onClick={() => setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')}
            >
              repeat: {repeat}
            </button>
          </div>
        </div>
      </Card>

      <Card title={`Library (${tracks.length})`}>
        <div className="row">
          <input placeholder="Search title, artist or album" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {visible.length === 0 ? (
          <EmptyState>{tracks.length === 0 ? 'No tracks yet — drop some audio files above.' : 'Nothing matches that search.'}</EmptyState>
        ) : (
          <ul className="list">
            {visible.map((track) => (
              <li key={track.id} className={track.id === currentId ? 'active' : undefined}>
                <button type="button" onClick={() => play(track)}>
                  {track.id === currentId && playing ? '❚❚' : '▶'}
                </button>
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
                <span className="muted">{track.bpm ? `${track.bpm} BPM` : ''}</span>
                <span className="muted right">{(track.size / 1024 / 1024).toFixed(1)} MB</span>
                <button type="button" className="ghost" onClick={() => removeTrack(track)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
