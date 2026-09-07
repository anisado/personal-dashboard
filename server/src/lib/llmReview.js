import { requireProvider } from './provider.js';

const BATCH_SIZE = 12;
const BATCH_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 600_000);

const SYSTEM_PROMPT = `You audit Arabic-to-English translations. For each numbered segment you receive the Arabic source and its English translation.
Report only real problems: mistranslation, omitted or added meaning, wrong terminology, wrong numbers/names/dates, grammar that changes meaning, or tone that misrepresents the source.
Ignore stylistic preferences that keep the meaning intact.
Respond with JSON only: {"issues":[{"segmentIndex":number,"severity":"high"|"medium"|"low","type":"mistranslation"|"omission"|"addition"|"terminology"|"grammar"|"tone","message":string,"suggestion":string}]}. Return an empty array when a batch is fine.`;

async function reviewBatch(batch, { apiKey, baseUrl, model, signal }) {
  const body = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: batch
          .map((segment) => `Segment ${segment.index}\nArabic: ${segment.source}\nEnglish: ${segment.target}`)
          .join('\n\n')
      }
    ]
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    throw new Error(`LLM review failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.issues) ? parsed.issues : [];
}

export async function reviewSegments(segments) {
  const { apiKey, baseUrl, model } = await requireProvider();

  const candidates = segments.filter((segment) => segment.source && segment.target && segment.confident !== false);
  const issues = [];

  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    const batchIndexes = new Set(batch.map((segment) => segment.index));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
    try {
      for (const issue of await reviewBatch(batch, { apiKey, baseUrl, model, signal: controller.signal })) {
        if (!batchIndexes.has(Number(issue.segmentIndex))) continue;
        issues.push({
          segmentIndex: Number(issue.segmentIndex),
          type: issue.type || 'mistranslation',
          severity: ['high', 'medium', 'low'].includes(issue.severity) ? issue.severity : 'medium',
          message: String(issue.message || '').slice(0, 500),
          detail: issue.suggestion ? `suggestion: ${String(issue.suggestion).slice(0, 500)}` : undefined,
          source: 'llm'
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { model, issues };
}
