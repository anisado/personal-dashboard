import { Router } from 'express';
import * as store from '../store.js';

export function crudRouter(collection, sanitize) {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await store.list(collection));
  });

  router.post('/', async (req, res) => {
    const payload = sanitize(req.body ?? {});
    if (payload.error) return res.status(400).json({ error: payload.error });
    res.status(201).json(await store.create(collection, payload.value));
  });

  router.patch('/:id', async (req, res) => {
    const payload = sanitize(req.body ?? {}, { partial: true });
    if (payload.error) return res.status(400).json({ error: payload.error });
    const item = await store.update(collection, req.params.id, payload.value);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  });

  router.delete('/:id', async (req, res) => {
    const deleted = await store.remove(collection, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  });

  return router;
}

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const tags = (value) =>
  Array.isArray(value) ? value.map(str).filter(Boolean) : str(value).split(',').map((t) => t.trim()).filter(Boolean);

export function taskSanitizer(body, { partial = false } = {}) {
  const title = str(body.title);
  if (!partial && !title) return { error: 'title is required' };
  const value = {};
  if (title || !partial) value.title = title;
  if (body.notes !== undefined) value.notes = str(body.notes);
  if (body.priority !== undefined) {
    value.priority = ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium';
  } else if (!partial) {
    value.priority = 'medium';
  }
  if (body.project !== undefined) value.project = str(body.project);
  if (body.dueDate !== undefined) value.dueDate = str(body.dueDate) || null;
  if (body.done !== undefined) value.done = Boolean(body.done);
  else if (!partial) value.done = false;
  return { value };
}

export function noteSanitizer(body, { partial = false } = {}) {
  const title = str(body.title);
  if (!partial && !title) return { error: 'title is required' };
  const value = {};
  if (title || !partial) value.title = title;
  if (body.body !== undefined || !partial) value.body = str(body.body);
  if (body.tags !== undefined || !partial) value.tags = tags(body.tags);
  return { value };
}

export function snippetSanitizer(body, { partial = false } = {}) {
  const title = str(body.title);
  const code = typeof body.code === 'string' ? body.code : '';
  if (!partial && (!title || !code)) return { error: 'title and code are required' };
  const value = {};
  if (title || !partial) value.title = title;
  if (body.code !== undefined || !partial) value.code = code;
  if (body.language !== undefined || !partial) value.language = str(body.language) || 'text';
  if (body.tags !== undefined || !partial) value.tags = tags(body.tags);
  return { value };
}

export function bookmarkSanitizer(body, { partial = false } = {}) {
  const title = str(body.title);
  const url = str(body.url);
  if (!partial && (!title || !url)) return { error: 'title and url are required' };
  if (url && !/^https?:\/\//i.test(url)) return { error: 'url must start with http:// or https://' };
  const value = {};
  if (title || !partial) value.title = title;
  if (url || !partial) value.url = url;
  if (body.category !== undefined || !partial) value.category = str(body.category) || 'general';
  return { value };
}

export function environmentSanitizer(body, { partial = false } = {}) {
  const name = str(body.name);
  const url = str(body.url);
  if (!partial && (!name || !url)) return { error: 'name and url are required' };
  if (url && !/^https?:\/\//i.test(url)) return { error: 'url must start with http:// or https://' };
  const value = {};
  if (name || !partial) value.name = name;
  if (url || !partial) value.url = url;
  if (body.kind !== undefined || !partial) value.kind = str(body.kind) || 'service';
  return { value };
}
