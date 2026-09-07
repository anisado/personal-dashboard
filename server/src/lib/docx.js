import { Document, Packer, Paragraph } from 'docx';
import mammoth from 'mammoth';

export async function extractParagraphs(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export async function buildDocx(paragraphs) {
  const document = new Document({
    sections: [
      {
        children: paragraphs.map((text) => new Paragraph({ text, spacing: { after: 160 } }))
      }
    ]
  });
  return Packer.toBuffer(document);
}
