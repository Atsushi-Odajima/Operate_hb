import type { Content, PMNode } from './content.js';
import { nodeText } from './content.js';
import { newPdf, pdfToBuffer } from './pdf.js';

const CLS_LABEL: Record<string, string> = { public_internal: '社内公開', internal: '社内限定', confidential: '機密', restricted: '極秘' };
export const classLabel = (c: string) => CLS_LABEL[c] ?? c;

export async function documentPdf(meta: {
  title: string; docNumber: string | null; version: string; classification: string; effectiveDate: string | null; publishedAt: string | null;
  owner: string | null; department: string | null; orgName: string; generatedBy: string; status: string;
}, content: Content): Promise<Buffer> {
  const doc = newPdf({ title: meta.title });
  const header = () => {
    // writing into the margins must not trigger another page break (would recurse via 'pageAdded')
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.font('jp').fontSize(8).fillColor('#64748B');
    doc.text(`${meta.orgName} ｜ ${meta.docNumber ?? ''} ${meta.title} ｜ v${meta.version} ｜ 区分: ${classLabel(meta.classification)}`, 50, 20, { width: doc.page.width - 100, lineBreak: false });
    doc.text(`出力: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ${meta.generatedBy} ｜ 最新版は Operate で確認してください`, 50, doc.page.height - 35, { width: doc.page.width - 100, lineBreak: false });
    if (meta.classification === 'confidential' || meta.classification === 'restricted') {
      doc.fontSize(60).fillColor('#DC2626').opacity(0.07).rotate(-30, { origin: [300, 420] }).text(classLabel(meta.classification), 120, 380, { lineBreak: false });
    }
    doc.restore();
    doc.page.margins.bottom = bottom;
    doc.x = 50;
    doc.y = 50;
  };
  doc.on('pageAdded', header);
  header();
  doc.font('jp-bold').fontSize(20).fillColor('#0B1A33').text(meta.title, 50, 50);
  doc.moveDown(0.3).font('jp').fontSize(9.5).fillColor('#334155');
  doc.text(`文書番号: ${meta.docNumber ?? '-'}　版: v${meta.version}　状態: ${meta.status}　機密区分: ${classLabel(meta.classification)}`);
  doc.text(`施行日: ${meta.effectiveDate ?? '-'}　公開日: ${meta.publishedAt ? new Date(meta.publishedAt).toLocaleDateString('ja-JP') : '-'}　担当: ${meta.owner ?? '-'}（${meta.department ?? '-'}）`);
  doc.moveDown(0.8).fillColor('#0F172A');

  const para = (t: string, size = 10.5, font = 'jp', indent = 0) => {
    if (!t.trim()) return;
    doc.font(font).fontSize(size).text(t.trim(), 50 + indent, undefined, { width: doc.page.width - 100 - indent, lineGap: 2 });
  };
  const walk = (n: PMNode, depth = 0) => {
    switch (n.type) {
      case 'heading':
        doc.moveDown(0.6);
        para(nodeText(n), Number(n.attrs?.level) <= 2 ? 14 : 12, 'jp-bold');
        doc.moveDown(0.2);
        break;
      case 'paragraph': para(nodeText(n), 10.5, 'jp', depth * 14); doc.moveDown(0.2); break;
      case 'bulletList': case 'orderedList': case 'taskList':
        (n.content ?? []).forEach((li, i) => {
          const mark = n.type === 'orderedList' ? `${i + 1}. ` : n.type === 'taskList' ? (li.attrs?.checked ? '☑ ' : '☐ ') : '・';
          const [first, ...rest] = li.content ?? [];
          para(mark + (first ? nodeText(first) : ''), 10.5, 'jp', depth * 14 + 6);
          rest.forEach((r) => walk(r, depth + 1));
        });
        doc.moveDown(0.2);
        break;
      case 'callout': {
        const k = n.attrs?.kind;
        doc.fillColor(k === 'danger' ? '#B91C1C' : k === 'warning' ? '#B45309' : '#1D4ED8');
        para(`${k === 'danger' ? '【危険】' : k === 'warning' ? '【注意】' : '【補足】'} ${nodeText(n)}`, 10.5, 'jp-bold', 6);
        doc.fillColor('#0F172A').moveDown(0.3);
        break;
      }
      case 'blockquote': para(`「${nodeText(n).trim()}」`, 10, 'jp', 12); break;
      case 'codeBlock': para(nodeText(n), 9, 'jp', 12); break;
      case 'table': (n.content ?? []).forEach((row) => para((row.content ?? []).map((c) => nodeText(c).trim()).join(' ｜ '), 9.5, 'jp', 6)); doc.moveDown(0.3); break;
      case 'image': para(`［画像: ${n.attrs?.alt || '添付画像'}］`, 9, 'jp', 6); break;
      case 'horizontalRule': doc.moveDown(0.5); break;
      default: (n.content ?? []).forEach((c) => walk(c, depth));
    }
  };
  (content.body.content ?? []).forEach((n) => walk(n));
  if (content.steps.length) {
    doc.moveDown(0.8);
    para('手順', 14, 'jp-bold');
    content.steps.forEach((s, i) => {
      doc.moveDown(0.4);
      para(`手順${i + 1}　${s.title}`, 11.5, 'jp-bold');
      para(s.instruction, 10.5, 'jp', 12);
      if (s.warning) { doc.fillColor('#B45309'); para(`【注意】${s.warning}`, 10, 'jp-bold', 12); doc.fillColor('#0F172A'); }
      if (s.expectedResult) para(`期待される結果: ${s.expectedResult}`, 10, 'jp', 12);
      s.checklist.forEach((c) => para(`☐ ${c}`, 10, 'jp', 18));
      if (s.reference) para(`参照: ${s.reference}`, 9, 'jp', 12);
    });
  }
  if (content.checklistItems.length) {
    doc.moveDown(0.8);
    para('チェック項目', 14, 'jp-bold');
    content.checklistItems.forEach((c) => para(`☐ ${c.text}${c.required ? '' : '（任意）'}`, 10.5, 'jp', 6));
  }
  return pdfToBuffer(doc);
}
