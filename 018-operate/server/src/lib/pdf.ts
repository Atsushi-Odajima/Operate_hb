import PDFDocument from 'pdfkit';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// src/lib or dist/lib -> ../../assets/fonts
export const FONT_REGULAR = join(here, '../../assets/fonts/NotoSansJP-Regular.otf');
export const FONT_BOLD = join(here, '../../assets/fonts/NotoSansJP-Bold.otf');

export function newPdf(opts: { title: string; landscape?: boolean }) {
  const doc = new PDFDocument({ size: 'A4', layout: opts.landscape ? 'landscape' : 'portrait', margin: 50, info: { Title: opts.title, Creator: 'Operate' } });
  doc.registerFont('jp', FONT_REGULAR);
  doc.registerFont('jp-bold', FONT_BOLD);
  doc.font('jp');
  return doc;
}

export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
