import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import * as store from '../store.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const MUSIC_DIR = path.join(DATA_DIR, 'music');

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
    res.status(204).end();
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

    res.setHeader('Content-Type', track.mime || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    // seeking in <audio> depends on byte ranges
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
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Audio file is missing on disk' });
    next(err);
  }
});

export default router;
