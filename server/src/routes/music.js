import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { parseFile } from 'music-metadata';
import * as store from '../store.js';
import { resolveStems, separationJob, startSeparation } from '../lib/stems.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const STEMS_DIR = path.join(MUSIC_DIR, 'stems');

const MIME_BY_EXTENSION = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm'
};

await fsp.mkdir(MUSIC_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, done) => done(null, MUSIC_DIR),
    filename: (req, file, done) => {
      const extension = path.extname(file.originalname).toLowerCase();
      done(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 25 },
  fileFilter: (req, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!MIME_BY_EXTENSION[extension]) return done(new Error(`${file.originalname} is not a supported audio file`));
    done(null, true);
  }
});

/** "Artist - Title.mp3" is the common naming scheme; fall back to the file name. */
function parseName(originalname) {
  const base = originalname.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const match = base.match(/^(.+?)\s+-\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { artist: '', title: base };
}

const COVER_EXTENSION = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Tag values and the embedded cover, written next to the audio file. */
async function readTags(file) {
  try {
    const { common } = await parseFile(path.join(MUSIC_DIR, file.filename), { skipCovers: false });
    const tags = {};
    if (common.title) tags.title = common.title.trim().slice(0, 200);
    if (common.artist) tags.artist = common.artist.trim().slice(0, 200);
    if (common.album) tags.album = common.album.trim().slice(0, 200);

    const picture = common.picture?.[0];
    const extension = picture && COVER_EXTENSION[picture.format];
    if (picture && extension) {
      const cover = `${path.parse(file.filename).name}${extension}`;
      await fsp.writeFile(path.join(MUSIC_DIR, cover), Buffer.from(picture.data));
      tags.cover = cover;
      tags.coverMime = picture.format;
    }
    return tags;
  } catch {
    return {};
  }
}

const router = Router();

router.get('/tracks', async (req, res) => {
  res.json(await store.list('tracks'));
});

router.post('/tracks', upload.array('files'), async (req, res, next) => {
  const files = req.files ?? [];
  if (files.length === 0) return res.status(400).json({ error: 'Upload at least one audio file as "files"' });

  try {
    const tracks = [];
    for (const file of files) {
      tracks.push(
        await store.create('tracks', {
          ...parseName(file.originalname),
          ...(await readTags(file)),
          file: file.originalname,
          storedName: file.filename,
          size: file.size,
          mime: MIME_BY_EXTENSION[path.extname(file.filename).toLowerCase()]
        })
      );
    }
    res.status(201).json(tracks);
  } catch (err) {
    next(err);
  }
});

router.patch('/tracks/:id', async (req, res) => {
  const payload = {};
  for (const field of ['title', 'artist', 'album']) {
    if (typeof req.body?.[field] === 'string') payload[field] = req.body[field].trim().slice(0, 200);
  }
  if (Number.isFinite(req.body?.bpm)) payload.bpm = Math.round(req.body.bpm);
  const track = await store.update('tracks', req.params.id, payload);
  if (!track) return res.status(404).json({ error: 'Not found' });
  res.json(track);
});

router.delete('/tracks/:id', async (req, res, next) => {
  try {
    const track = await store.get('tracks', req.params.id);
    if (!track) return res.status(404).json({ error: 'Not found' });
    await store.remove('tracks', track.id);
    await fsp.rm(path.join(MUSIC_DIR, track.storedName), { force: true });
    await fsp.rm(path.join(STEMS_DIR, track.id), { force: true, recursive: true });
    if (track.cover) await fsp.rm(path.join(MUSIC_DIR, track.cover), { force: true });

    for (const playlist of await store.list('playlists')) {
      if (playlist.trackIds?.includes(track.id)) {
        await store.update('playlists', playlist.id, {
          trackIds: playlist.trackIds.filter((id) => id !== track.id)
        });
      }
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Range-aware file streaming, which is what <audio> seeking needs. */
function streamFile(req, res, file, mime, size) {
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', size);
  return fs.createReadStream(file).pipe(res);
}

/** Stems already on disk for a track, in mixer order. */
async function existingStems(trackId) {
  try {
    const files = await fsp.readdir(path.join(STEMS_DIR, trackId));
    const names = files.filter((file) => file.endsWith('.mp3')).map((file) => path.parse(file).name);
    return ['vocals', 'drums', 'bass', 'other'].filter((stem) => names.includes(stem));
  } catch {
    return [];
  }
}

router.get('/stems/status', async (req, res) => {
  const service = await resolveStems({ force: req.query.refresh === '1' });
  res.json({ available: Boolean(service), model: service?.model ?? null });
});

/** Separation state of the whole library, so the tab can show it per row. */
router.get('/stems/library', async (req, res, next) => {
  try {
    const service = await resolveStems();
    const states = {};
    for (const track of await store.list('tracks')) {
      const stems = await existingStems(track.id);
      if (stems.length > 0) {
        states[track.id] = { state: 'done', progress: 1, stems };
        continue;
      }
      const job = track.stemJob && service ? await separationJob(service.baseUrl, track.stemJob) : null;
      states[track.id] = job ?? { state: 'idle', progress: 0, stems: [] };
    }
    res.json({ available: Boolean(service), tracks: states });
  } catch (err) {
    next(err);
  }
});

router.get('/tracks/:id/stems', async (req, res, next) => {
  try {
    const track = await store.get('tracks', req.params.id);
    if (!track) return res.status(404).json({ error: 'Not found' });

    const stems = await existingStems(track.id);
    if (stems.length > 0) return res.json({ state: 'done', progress: 1, stems });

    const service = await resolveStems();
    if (track.stemJob && service) {
      const job = await separationJob(service.baseUrl, track.stemJob);
      if (job?.state === 'done') {
        return res.json({ state: 'done', progress: 1, stems: await existingStems(track.id) });
      }
      if (job) return res.json(job);
    }
    res.json({ state: 'idle', progress: 0, stems: [], available: Boolean(service) });
  } catch (err) {
    next(err);
  }
});

router.post('/tracks/:id/stems', async (req, res, next) => {
  try {
    const track = await store.get('tracks', req.params.id);
    if (!track) return res.status(404).json({ error: 'Not found' });

    const service = await resolveStems({ force: true });
    if (!service) {
      return res.status(503).json({
        error: 'Stem separation is unavailable — start it with: docker compose --profile stems up -d --build'
      });
    }

    const job = await startSeparation(
      service.baseUrl,
      path.posix.join('music', track.storedName),
      path.posix.join('music', 'stems', track.id)
    );
    await store.update('tracks', track.id, { stemJob: job.id });
    res.status(202).json(job);
  } catch (err) {
    next(err);
  }
});

router.get('/tracks/:id/stems/:stem/stream', async (req, res, next) => {
  try {
    const stem = path.basename(req.params.stem, '.mp3');
    const file = path.join(STEMS_DIR, req.params.id, `${stem}.mp3`);
    const { size } = await fsp.stat(file);
    streamFile(req, res, file, 'audio/mpeg', size);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Stem has not been separated yet' });
    next(err);
  }
});

router.get('/playlists', async (req, res) => {
  res.json(await store.list('playlists'));
});

router.post('/playlists', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'A playlist needs a name' });
  res.status(201).json(await store.create('playlists', { name, trackIds: [] }));
});

router.patch('/playlists/:id', async (req, res) => {
  const payload = {};
  if (typeof req.body?.name === 'string') payload.name = req.body.name.trim().slice(0, 120);
  if (Array.isArray(req.body?.trackIds)) payload.trackIds = req.body.trackIds.filter((id) => typeof id === 'string');
  const playlist = await store.update('playlists', req.params.id, payload);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  res.json(playlist);
});

router.delete('/playlists/:id', async (req, res) => {
  const removed = await store.remove('playlists', req.params.id);
  if (!removed) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

router.post('/playlists/:id/tracks', async (req, res) => {
  const playlist = await store.get('playlists', req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  const track = await store.get('tracks', String(req.body?.trackId ?? ''));
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const trackIds = playlist.trackIds ?? [];
  if (trackIds.includes(track.id)) return res.json(playlist);
  res.json(await store.update('playlists', playlist.id, { trackIds: [...trackIds, track.id] }));
});

router.delete('/playlists/:id/tracks/:trackId', async (req, res) => {
  const playlist = await store.get('playlists', req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  res.json(
    await store.update('playlists', playlist.id, {
      trackIds: (playlist.trackIds ?? []).filter((id) => id !== req.params.trackId)
    })
  );
});

router.get('/tracks/:id/cover', async (req, res, next) => {
  try {
    const track = await store.get('tracks', req.params.id);
    if (!track?.cover) return res.status(404).json({ error: 'No cover art' });
    res.setHeader('Content-Type', track.coverMime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(path.join(MUSIC_DIR, track.cover)).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.get('/tracks/:id/stream', async (req, res, next) => {
  try {
    const track = await store.get('tracks', req.params.id);
    if (!track) return res.status(404).json({ error: 'Not found' });
    const file = path.join(MUSIC_DIR, track.storedName);
    const { size } = await fsp.stat(file);
    streamFile(req, res, file, track.mime, size);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Audio file is missing on disk' });
    next(err);
  }
});

export default router;
