import { Router } from 'express';
import multer from 'multer';
import { buildDocx, extractParagraphs } from '../lib/docx.js';
import { reviewSegments } from '../lib/llmReview.js';
import { resolveProvider } from '../lib/provider.js';
import { auditTranslation } from '../lib/translationAudit.js';
import { translateParagraphs } from '../lib/translator.js';
import * as store from '../store.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 }
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const router = Router();

const UNAVAILABLE = 'No model reachable — start Ollama (ollama serve) or set OPENAI_API_KEY';

router.get('/config', async (req, res) => {
  const provider = await resolveProvider({ force: req.query.refresh === 'true' });
  res.json({
    llmAvailable: Boolean(provider),
    translationAvailable: Boolean(provider),
    model: provider?.model ?? null,
    endpoint: provider?.baseUrl ?? null
  });
});

router.get('/translations', async (req, res) => {
  const translations = await store.list('translations');
  res.json(translations.map(({ segments, ...rest }) => ({ ...rest, paragraphs: segments.length })));
});

router.get('/translations/:id', async (req, res) => {
  const record = await store.get('translations', req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  res.json(record);
});

router.delete('/translations/:id', async (req, res) => {
  const deleted = await store.remove('translations', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

router.get('/translations/:id/docx', async (req, res, next) => {
  try {
    const record = await store.get('translations', req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    const buffer = await buildDocx(record.segments.map((segment) => segment.target).filter(Boolean));
    const name = record.file.replace(/\.docx$/i, '') || 'translation';
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}-en.docx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/translate', upload.single('source'), async (req, res, next) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload the Arabic document as "source"' });
  if (file.mimetype !== DOCX_MIME && !file.originalname.toLowerCase().endsWith('.docx')) {
    return res.status(400).json({ error: `${file.originalname} is not a .docx file` });
  }
  if (!(await resolveProvider())) {
    return res.status(503).json({ error: UNAVAILABLE });
  }

  try {
    const paragraphs = await extractParagraphs(file.buffer);
    if (paragraphs.length === 0) {
      return res.status(400).json({ error: 'The document contains no readable text' });
    }

    let glossary = {};
    if (req.body?.glossary) {
      try {
        const parsed = JSON.parse(req.body.glossary);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) glossary = parsed;
      } catch {
        return res.status(400).json({ error: 'glossary must be a JSON object of Arabic -> English terms' });
      }
    }

    const { model, segments } = await translateParagraphs(paragraphs, { glossary });
    const record = await store.create('translations', {
      file: file.originalname,
      model,
      segments
    });
    res.json(record);
  } catch (err) {
    if (err.message?.includes('end of central directory')) {
      return res.status(400).json({ error: 'Could not read the .docx file — is it a real Word document?' });
    }
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error:
          'Translation timed out — the model is too slow for this document; try a smaller model or raise TRANSLATION_TIMEOUT_MS'
      });
    }
    next(err);
  }
});

router.post('/retranslate', async (req, res, next) => {
  const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
  if (!source) return res.status(400).json({ error: 'Send the Arabic text as "source"' });
  if (!(await resolveProvider())) return res.status(503).json({ error: UNAVAILABLE });

  try {
    const { model, segments } = await translateParagraphs([source]);
    res.json({ model, target: segments[0]?.target ?? '' });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Retranslation timed out' });
    next(err);
  }
});

router.get('/audits', async (req, res) => {
  res.json(await store.list('audits'));
});

router.delete('/audits/:id', async (req, res) => {
  const deleted = await store.remove('audits', req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

router.post(
  '/audit',
  upload.fields([
    { name: 'source', maxCount: 1 },
    { name: 'target', maxCount: 1 }
  ]),
  async (req, res, next) => {
    const source = req.files?.source?.[0];
    const target = req.files?.target?.[0];
    if (!source || !target) {
      return res.status(400).json({ error: 'Upload both files: "source" (Arabic) and "target" (English)' });
    }
    for (const file of [source, target]) {
      if (file.mimetype !== DOCX_MIME && !file.originalname.toLowerCase().endsWith('.docx')) {
        return res.status(400).json({ error: `${file.originalname} is not a .docx file` });
      }
    }

    try {
      const [sourceParagraphs, targetParagraphs] = await Promise.all([
        extractParagraphs(source.buffer),
        extractParagraphs(target.buffer)
      ]);
      if (sourceParagraphs.length === 0 || targetParagraphs.length === 0) {
        return res.status(400).json({ error: 'One of the documents contains no readable text' });
      }

      const result = auditTranslation(sourceParagraphs, targetParagraphs);
      result.files = { source: source.originalname, target: target.originalname };
      result.llm = { requested: req.query.llm === 'true', available: Boolean(await resolveProvider()) };

      if (result.llm.requested && result.llm.available) {
        try {
          const review = await reviewSegments(result.segments);
          result.llm.model = review.model;
          result.issues = [...result.issues, ...review.issues].sort((a, b) => a.segmentIndex - b.segmentIndex);
          const ratings = new Map(review.ratings.map((rating) => [rating.segmentIndex, rating]));
          for (const segment of result.segments) {
            segment.issues = result.issues.filter((issue) => issue.segmentIndex === segment.index);
            const rating = ratings.get(segment.index);
            if (rating) {
              segment.rating = rating.rating;
              segment.note = rating.note || undefined;
              segment.fix = rating.fix || undefined;
            }
          }
          result.summary.quality = { ...review.quality, model: review.model };
          result.summary.issues = result.issues.length;
          for (const issue of review.issues) {
            result.summary.bySeverity[issue.severity] += 1;
            result.summary.byType[issue.type] = (result.summary.byType[issue.type] || 0) + 1;
          }
        } catch (err) {
          result.llm.error = err.message;
        }
      }

      await store.create('audits', {
        files: result.files,
        summary: result.summary,
        llmModel: result.llm.model ?? null
      });

      res.json(result);
    } catch (err) {
      if (err.message?.includes('end of central directory')) {
        return res.status(400).json({ error: 'Could not read the .docx file — is it a real Word document?' });
      }
      next(err);
    }
  }
);

export default router;
