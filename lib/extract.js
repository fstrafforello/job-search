// Turns an uploaded resume or job posting (PDF, Word .docx, text) into plain text / Markdown, locally.
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export class ExtractError extends Error {
  constructor(message) { super(message); this.status = 422; }
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fromPdf(buffer) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  } catch (e) {
    if (e?.name === 'PasswordException') throw new ExtractError('This PDF is password-protected. Remove the password (or export a new PDF) and try again.');
    throw new ExtractError('This PDF could not be read. It may be damaged; try exporting it again.');
  }
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const result = tidy(text);
  if (result.replace(/\s/g, '').length < 30) {
    throw new ExtractError('This PDF has no selectable text. It is probably a scanned image. Open the original document (e.g. in Word) and save it as PDF again, or paste the text in.');
  }
  return { text: result, pages: totalPages };
}

// Mammoth doesn't know Word's built-in Title/Subtitle styles; treat them as headings.
const STYLE_MAP = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];

async function fromDocx(buffer) {
  let value;
  try {
    ({ value } = await mammoth.convertToMarkdown({ buffer }, { styleMap: STYLE_MAP }));
  } catch {
    throw new ExtractError('This Word file could not be read. It may be damaged; try saving it again in Word.');
  }
  // Mammoth escapes Markdown punctuation ("example\.com"); plain text reads better for people and models.
  const result = tidy(value.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1'));
  if (!result) throw new ExtractError('This Word file has no text in it.');
  return { text: result };
}

export async function extractDocumentText(buffer, filename = '') {
  const ext = path.extname(filename).toLowerCase();
  const magic = buffer.subarray(0, 5).toString('latin1');

  if (magic === '%PDF-') return { ...(await fromPdf(buffer)), format: 'pdf' };
  if (magic.startsWith('PK') && ext !== '.doc') return { ...(await fromDocx(buffer)), format: 'docx' };
  if (ext === '.doc' || buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw new ExtractError('Old Word files (.doc) aren\'t supported. Open it in Word and use Save As → Word Document (.docx) or PDF.');
  }
  if (['.txt', '.md', '.markdown', '.text', ''].includes(ext)) {
    const text = tidy(buffer.toString('utf8').replace(/^﻿/, ''));
    if (!text) throw new ExtractError('This file is empty.');
    return { text, format: 'text' };
  }
  throw new ExtractError('Unsupported file type. Use a PDF, a Word document (.docx) or a text file.');
}
