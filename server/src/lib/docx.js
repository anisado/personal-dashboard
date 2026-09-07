import mammoth from 'mammoth';

export async function extractParagraphs(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
