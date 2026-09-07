const BATCH_SIZE = 8;
const TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT = `You are a sworn legal translator working from Arabic into English.
Translate each numbered paragraph faithfully and completely:
- keep the legal register and sentence structure of the source; do not summarise, explain, localise or add anything;
- translate every clause, proviso, date, amount, party name and reference exactly, keeping Arabic-Indic digits converted to Western digits;
- transliterate personal names and untranslatable proper nouns, keeping the Arabic in parentheses the first time it appears;
- use standard legal English terminology (e.g. "الطرف الأول" -> "the First Party", "بموجب" -> "pursuant to") and keep every term rendered identically throughout the document;
- keep numbering, article headings and list markers in place.
Respond with JSON only: {"translations":[{"index":number,"text":string}]} covering every paragraph you were given.`;

export function translatorConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function config() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  return {
    apiKey,
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  };
}

async function translateBatch(batch, glossary, { apiKey, baseUrl, model, signal }) {
  const glossaryLines = Object.entries(glossary).slice(0, 80);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (glossaryLines.length > 0) {
    messages.push({
      role: 'system',
      content: `Use these established renderings for consistency:\n${glossaryLines
        .map(([arabic, english]) => `${arabic} -> ${english}`)
        .join('\n')}`
    });
  }
  messages.push({
    role: 'user',
    content: batch.map((item) => `Paragraph ${item.index}\n${item.source}`).join('\n\n')
  });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages }),
    signal
  });

  if (!response.ok) {
    throw new Error(`Translation failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }

  const data = await response.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
  const translations = Array.isArray(parsed.translations) ? parsed.translations : [];
  const byIndex = new Map(translations.map((item) => [Number(item.index), String(item.text ?? '').trim()]));
  return batch.map((item) => ({ ...item, target: byIndex.get(item.index) || '' }));
}

/**
 * Translates Arabic paragraphs into English one batch at a time, feeding a
 * running glossary forward so recurring legal terms stay consistent.
 */
export async function translateParagraphs(paragraphs, { glossary = {} } = {}) {
  const settings = config();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const items = paragraphs.map((source, index) => ({ index: index + 1, source }));

  try {
    const segments = [];
    for (let start = 0; start < items.length; start += BATCH_SIZE) {
      const batch = items.slice(start, start + BATCH_SIZE);
      segments.push(...(await translateBatch(batch, glossary, { ...settings, signal: controller.signal })));
    }
    return { model: settings.model, segments };
  } finally {
    clearTimeout(timeout);
  }
}
