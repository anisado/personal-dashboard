const CACHE_MS = 30_000;
// a missing server is usually one someone is about to start, so re-probe often
const MISS_CACHE_MS = 3000;
const PROBE_MS = 1500;

// Ollama (and other local servers) are looked for on the host and on a
// container named "ollama", so the app works without any configuration.
const LOCAL_CANDIDATES = [
  'http://host.docker.internal:11434/v1',
  'http://127.0.0.1:11434/v1',
  'http://ollama:11434/v1',
  'http://host.docker.internal:1234/v1',
  'http://127.0.0.1:1234/v1'
];

let cached = null;

function trim(url) {
  return url.replace(/\/$/, '');
}

async function listModels(baseUrl, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_MS);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data.data) ? data.data.map((entry) => entry.id) : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function pickModel(models) {
  if (process.env.OPENAI_MODEL) return process.env.OPENAI_MODEL;
  if (!models || models.length === 0) return null;
  const instruct = models.find((id) => /instruct|chat/i.test(id));
  return instruct ?? models[0];
}

async function detect() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (process.env.OPENAI_BASE_URL) {
    const baseUrl = trim(process.env.OPENAI_BASE_URL);
    const models = await listModels(baseUrl, apiKey || 'local');
    return { baseUrl, apiKey: apiKey || 'local', model: pickModel(models) ?? 'gpt-4o-mini', source: 'configured' };
  }

  if (apiKey) {
    return {
      baseUrl: 'https://api.openai.com/v1',
      apiKey,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      source: 'openai'
    };
  }

  for (const baseUrl of LOCAL_CANDIDATES) {
    const models = await listModels(baseUrl, 'local');
    const model = pickModel(models);
    if (model) return { baseUrl, apiKey: 'local', model, source: 'local' };
  }

  return null;
}

/** Resolves the OpenAI-compatible endpoint to use, re-probing periodically. */
export async function resolveProvider({ force = false } = {}) {
  const ttl = cached?.provider ? CACHE_MS : MISS_CACHE_MS;
  if (!force && cached && Date.now() - cached.at < ttl) return cached.provider;
  const provider = await detect();
  cached = { at: Date.now(), provider };
  return provider;
}

export async function requireProvider() {
  const provider = await resolveProvider();
  if (!provider) {
    throw new Error('No model available — start Ollama (ollama serve) or set OPENAI_API_KEY');
  }
  return provider;
}
