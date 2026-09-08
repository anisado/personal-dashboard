import { useEffect, useMemo, useRef, useState } from 'react';
import { BASE, api } from '../api.js';
import { Card, EmptyState, ErrorBanner, Page } from '../components/Page.jsx';

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function Music() {
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [currentId, setCurrentId] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState({ time: 0, duration: 0 });
  const [volume, setVolume] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState('off');
  const [search, setSearch] = useState('');
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

  const upload = async (event) => {
    event.preventDefault();
    const files = fileRef.current?.files;
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
  };

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

  return (
    <Page title="Music" subtitle="Your own library, streamed from the dashboard API.">
      <ErrorBanner message={error} />

      <Card title="Add music">
        <form className="row" onSubmit={upload}>
          <input type="file" accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav" multiple ref={fileRef} />
          <button type="submit" disabled={uploading}>
            {uploading ? 'uploading…' : 'Upload'}
          </button>
        </form>
      </Card>

      <Card title={current ? `${current.title}${current.artist ? ` — ${current.artist}` : ''}` : 'Player'}>
        {current ? (
          <div className="form-stack">
            <audio
              ref={audioRef}
              src={`${BASE}/music/tracks/${current.id}/stream`}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(event) =>
                setProgress({ time: event.target.currentTime, duration: event.target.duration || 0 })
              }
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
            <div className="row">
              <button type="button" onClick={() => step(-1)}>
                ⏮
              </button>
              <button type="button" onClick={() => play(current)}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <button type="button" onClick={() => step(1)}>
                ⏭
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
              onChange={(event) => {
                audioRef.current.currentTime = Number(event.target.value);
                setProgress((current) => ({ ...current, time: Number(event.target.value) }));
              }}
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
        ) : (
          <EmptyState>Pick a track from the library to start playing.</EmptyState>
        )}
      </Card>

      <Card title={`Library (${tracks.length})`}>
        <div className="row">
          <input placeholder="Search title, artist or album" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {visible.length === 0 ? (
          <EmptyState>{tracks.length === 0 ? 'No tracks yet — upload some audio files.' : 'Nothing matches that search.'}</EmptyState>
        ) : (
          <ul className="list">
            {visible.map((track) => (
              <li key={track.id} className={track.id === currentId ? 'active' : undefined}>
                <button type="button" onClick={() => play(track)}>
                  {track.id === currentId && playing ? '⏸' : '▶'}
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
