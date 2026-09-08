const PROBE_MS = 1500;
const CACHE_MS = 15_000;

// the separation service is looked for as a compose service and on the host,
// so no configuration is needed in either setup
const CANDIDATES = ['http://stems:8001', 'http://host.docker.internal:8001', 'http://127.0.0.1:8001'];

let cached = null;

async function probe(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_MS);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const health = await response.json();
    return { baseUrl, model: health.model, stems: health.stems ?? [] };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolves the running Demucs service, re-probing periodically. */
export async function resolveStems({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.service;

  const urls = process.env.STEMS_URL ? [process.env.STEMS_URL.replace(/\/$/, '')] : CANDIDATES;
  let service = null;
  for (const url of urls) {
    service = await probe(url);
    if (service) break;
  }
  cached = { at: Date.now(), service };
  return service;
}

export async function startSeparation(baseUrl, source, target) {
  const response = await fetch(`${baseUrl}/separate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Separation could not be started');
  return body;
}

export async function separationJob(baseUrl, jobId) {
  const response = await fetch(`${baseUrl}/jobs/${jobId}`);
  if (!response.ok) return null;
  return response.json();
}
