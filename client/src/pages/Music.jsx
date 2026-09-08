import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';

const PEAK_COUNT = 900;

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Downsample the decoded audio to one peak per pixel column. */
function peaksFrom(buffer) {
  const channel = buffer.getChannelData(0);
  const perBucket = Math.floor(channel.length / PEAK_COUNT) || 1;
  const peaks = new Float32Array(PEAK_COUNT);
  for (let bucket = 0; bucket < PEAK_COUNT; bucket += 1) {
    let max = 0;
    const start = bucket * perBucket;
    for (let offset = 0; offset < perBucket; offset += 1) {
      const value = Math.abs(channel[start + offset] || 0);
      if (value > max) max = value;
    }
    peaks[bucket] = max;
  }
  const loudest = peaks.reduce((max, value) => Math.max(max, value), 0) || 1;
  return peaks.map((value) => value / loudest);
}

function Waveform({ peaks, progress, duration, loading, onSeek }) {
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

    const played = duration ? Math.min(progress / duration, 1) : 0;
    const bars = peaks?.length ?? 0;
    const middle = height / 2;

    if (bars === 0) {
      context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      context.beginPath();
      context.moveTo(0, middle);
      context.lineTo(width, middle);
      context.stroke();
      return;
    }

    const barWidth = width / bars;
    for (let index = 0; index < bars; index += 1) {
      const amplitude = Math.max(peaks[index] * (height / 2 - 2), 1);
      context.fillStyle = index / bars <= played ? '#22d3ee' : 'rgba(148, 163, 184, 0.45)';
      context.fillRect(index * barWidth, middle - amplitude, Math.max(barWidth - 0.5, 0.5), amplitude * 2);
    }
  }, [peaks, progress, duration]);

  return (
    <div className="waveform">
      <canvas
        ref={canvasRef}
        onClick={(event) => {
          if (!duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek(((event.clientX - rect.left) / rect.width) * duration);
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
  const audioRef = useRef(null);
  const fileRef = useRef(null);

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
    if (!currentId) return undefined;

    let cancelled = false;
    const controller = new AbortController();
    setPeaksLoading(true);

    (async () => {
      let context;
      try {
        const response = await fetch(`${BASE}/music/tracks/${currentId}/stream`, { signal: controller.signal });
        const bytes = await response.arrayBuffer();
        context = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await context.decodeAudioData(bytes);
        if (!cancelled) setPeaks(peaksFrom(decoded));
      } catch (err) {
        if (!cancelled && err.name !== 'AbortError') setPeaks(null);
      } finally {
        context?.close();
        if (!cancelled) setPeaksLoading(false);
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

          <Waveform
            peaks={peaks}
            progress={progress.time}
            duration={progress.duration}
            loading={peaksLoading}
            onSeek={seek}
          />

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
