import { Router } from 'express';
import multer from 'multer';
import { extractParagraphs } from '../lib/docx.js';
import { llmConfigured, reviewSegments } from '../lib/llmReview.js';
import { auditTranslation } from '../lib/translationAudit.js';
import * as store from '../store.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 }
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const router = Router();

router.get('/config', (req, res) => {
  res.json({ llmAvailable: llmConfigured(), model: process.env.OPENAI_MODEL || 'gpt-4o-mini' });
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
      result.llm = { requested: req.query.llm === 'true', available: llmConfigured() };

      if (result.llm.requested && result.llm.available) {
        try {
          const review = await reviewSegments(result.segments);
          result.llm.model = review.model;
          result.issues = [...result.issues, ...review.issues].sort((a, b) => a.segmentIndex - b.segmentIndex);
          for (const segment of result.segments) {
            segment.issues = result.issues.filter((issue) => issue.segmentIndex === segment.index);
          }
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
