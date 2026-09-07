import { requireProvider } from './provider.js';

const BATCH_SIZE = 8;
const RATINGS = ['accurate', 'minor', 'major', 'wrong'];
const RATING_SCORE = { accurate: 100, minor: 80, major: 40, wrong: 0 };
const BATCH_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 600_000);

const SYSTEM_PROMPT = `You audit Arabic-to-English legal translations. For each numbered segment you receive the Arabic source and its English translation.
Grade every segment you are given:
- "accurate": the English conveys the full legal meaning of the Arabic.
- "minor": meaning preserved but wording, terminology or register could be better.
- "major": meaning is distorted, something material is missing or added.
- "wrong": the English does not translate this Arabic at all.
Judge meaning, not style. Do not invent problems; an idiomatic, complete rendering is "accurate".
For every issue, quote the exact words, numbers or dates that need revision: "sourceSpan" copied verbatim from the Arabic and "targetSpan" copied verbatim from the English (use "" when the problem is a pure omission or addition on that side).
When a segment is rated "major" or "wrong", also give "fix": a corrected English rendering of the whole segment.
Respond with JSON only:
{"segments":[{"index":number,"rating":"accurate"|"minor"|"major"|"wrong","note":string,"fix":string,"issues":[{"severity":"high"|"medium"|"low","type":"mistranslation"|"omission"|"addition"|"terminology"|"grammar"|"tone","message":string,"sourceSpan":string,"targetSpan":string,"suggestion":string}]}]}
Grade every index in the batch. Leave "issues" empty for accurate segments and keep "note" short (or empty when accurate).`;

/** Spans are only useful if the model quoted the text verbatim; drop anything it paraphrased. */
function verifySpan(span, text) {
  const value = String(span || '').trim();
  if (!value || value.length < 2) return null;
  if (text.includes(value)) return value;
  const match = text.match(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  return match ? match[0] : null;
}

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
  return Array.isArray(parsed.segments) ? parsed.segments : [];
}

export async function reviewSegments(segments) {
  const { apiKey, baseUrl, model } = await requireProvider();

  const candidates = segments.filter((segment) => segment.source && segment.target && segment.confident !== false);
  const issues = [];
  const ratings = [];

  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    const batchIndexes = new Set(batch.map((segment) => segment.index));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
    try {
      for (const graded of await reviewBatch(batch, { apiKey, baseUrl, model, signal: controller.signal })) {
        const index = Number(graded.index);
        if (!batchIndexes.has(index)) continue;
        const rating = RATINGS.includes(graded.rating) ? graded.rating : 'minor';
        const segment = batch.find((candidate) => candidate.index === index);
        ratings.push({
          segmentIndex: index,
          rating,
          note: String(graded.note || '').slice(0, 500),
          fix: rating === 'major' || rating === 'wrong' ? String(graded.fix || '').slice(0, 2000) : ''
        });
        for (const issue of Array.isArray(graded.issues) ? graded.issues : []) {
          issues.push({
            segmentIndex: index,
            type: issue.type || 'mistranslation',
            severity: ['high', 'medium', 'low'].includes(issue.severity) ? issue.severity : 'medium',
            message: String(issue.message || '').slice(0, 500),
            detail: issue.suggestion ? `suggestion: ${String(issue.suggestion).slice(0, 500)}` : undefined,
            spans: {
              source: [verifySpan(issue.sourceSpan, segment?.source ?? '')].filter(Boolean),
              target: [verifySpan(issue.targetSpan, segment?.target ?? '')].filter(Boolean)
            },
            source: 'llm'
          });
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const counts = { accurate: 0, minor: 0, major: 0, wrong: 0 };
  for (const { rating } of ratings) counts[rating] += 1;
  const score = ratings.length
    ? Math.round(ratings.reduce((sum, { rating }) => sum + RATING_SCORE[rating], 0) / ratings.length)
    : null;

  return {
    model,
    issues,
    ratings,
    quality: {
      score,
      verdict:
        score === null
          ? 'not rated'
          : score >= 90
            ? 'faithful translation'
            : score >= 75
              ? 'usable, some wording to fix'
              : score >= 50
                ? 'meaning drifts — needs correction'
                : 'not a reliable translation',
      rated: ratings.length,
      unrated: candidates.length - ratings.length,
      counts
    }
  };
}
