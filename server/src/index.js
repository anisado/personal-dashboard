import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import {
  bookmarkSanitizer,
  crudRouter,
  environmentSanitizer,
  noteSanitizer,
  snippetSanitizer,
  taskSanitizer
} from './routes/crud.js';
import toolsRouter from './routes/tools.js';
import translationRouter from './routes/translation.js';
import * as store from './store.js';

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('tiny'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), now: new Date().toISOString() });
});

app.get('/api/stats', async (req, res) => {
  res.json(await store.stats());
});

app.use('/api/tasks', crudRouter('tasks', taskSanitizer));
app.use('/api/notes', crudRouter('notes', noteSanitizer));
app.use('/api/snippets', crudRouter('snippets', snippetSanitizer));
app.use('/api/bookmarks', crudRouter('bookmarks', bookmarkSanitizer));
app.use('/api/environments', crudRouter('environments', environmentSanitizer));
app.use('/api/tools', toolsRouter);
app.use('/api/translation', translationRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 15 MB' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
