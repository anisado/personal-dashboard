import { Router } from 'express';
import crypto from 'node:crypto';
import { nextCronRuns } from '../lib/cron.js';

const router = Router();

router.get('/uuid', (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 1, 1), 50);
  res.json({ uuids: Array.from({ length: count }, () => crypto.randomUUID()) });
});

router.post('/hash', (req, res) => {
  const { text = '', algorithms = ['md5', 'sha1', 'sha256', 'sha512'] } = req.body ?? {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'text must be a string' });
  const available = crypto.getHashes();
  const digests = {};
  for (const algorithm of algorithms) {
    if (!available.includes(algorithm)) continue;
    digests[algorithm] = crypto.createHash(algorithm).update(text).digest('hex');
  }
  res.json({ digests });
});

router.post('/jwt/decode', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const parts = token.split('.');
  if (parts.length < 2) return res.status(400).json({ error: 'Not a valid JWT' });
  try {
    const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
    res.json({
      header,
      payload,
      signature: parts[2] ?? null,
      expiresAt,
      expired: payload.exp ? payload.exp * 1000 < Date.now() : null
    });
  } catch {
    res.status(400).json({ error: 'Could not decode token' });
  }
});

router.post('/cron', (req, res) => {
  const expression = typeof req.body?.expression === 'string' ? req.body.expression.trim() : '';
  try {
    res.json({ expression, runs: nextCronRuns(expression, 5).map((date) => date.toISOString()) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/http', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body ?? {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
      signal: controller.signal
    });
    const text = await response.text();
    res.json({
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - startedAt,
      headers: Object.fromEntries(response.headers.entries()),
      body: text.slice(0, 100_000)
    });
  } catch (err) {
    res.status(502).json({ error: err.name === 'AbortError' ? 'Request timed out' : err.message });
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
