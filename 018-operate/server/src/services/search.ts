import type { Db } from '../db/pool.js';
import { embed, EMBED_MODEL, normalizeText, toVector } from '../ai/embed.js';
import { docReadable, type Actor } from '../lib/authz.js';
import { sections, type Content } from '../lib/content.js';
import { sha256 } from '../lib/crypto.js';
import { and, raw, sql, type SQL } from '../lib/sql.js';

/**
 * Search index contains ONLY the current Published version of each document. It is updated synchronously inside
 * the publish / retire / metadata-change transaction, so there is no window where a retired document is searchable.
 * ACL is never stored in the index: every query joins the live `documents` / `document_audiences` / membership
 * tables, so permission changes apply to the very next query.
 */
export async function reindexDocument(db: Db, documentId: string) {
  const d = await db.one(sql`
    SELECT d.*, v.id AS vid, v.title AS vtitle, v.content, v.body_text, u.name AS owner_name
      FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.id = ${documentId}`);
  if (!d || d.status !== 'published' || !d.vid) {
    await db.exec(sql`DELETE FROM search_index WHERE document_id = ${documentId}`);
    await db.exec(sql`UPDATE knowledge_chunks SET is_current = false WHERE document_id = ${documentId} AND is_current`);
    return;
  }
  const rel = await db.q(sql`SELECT d2.title FROM document_relations r JOIN documents d2 ON d2.id = r.to_document_id WHERE r.from_document_id = ${documentId} LIMIT 20`);
  const related = rel.map((r) => r.title).join(' ');
  const tags = (d.tags as string[]).join(' ');
  const searchText = normalizeText([d.doc_number ?? '', d.vtitle, d.summary, tags, d.category, d.owner_name ?? '', related, d.body_text].join('\n'));
  await db.exec(sql`
    INSERT INTO search_index (document_id, org_id, version_id, title, summary, body_text, tags, category, doc_number, owner_name, related_titles, search_text, indexed_at)
    VALUES (${documentId}, ${db.orgId}, ${d.vid}, ${d.vtitle}, ${d.summary}, ${d.body_text}, ${tags}, ${d.category}, ${d.doc_number ?? ''}, ${d.owner_name ?? ''}, ${related}, ${searchText}, now())
    ON CONFLICT (document_id) DO UPDATE SET version_id = EXCLUDED.version_id, title = EXCLUDED.title, summary = EXCLUDED.summary,
      body_text = EXCLUDED.body_text, tags = EXCLUDED.tags, category = EXCLUDED.category, doc_number = EXCLUDED.doc_number,
      owner_name = EXCLUDED.owner_name, related_titles = EXCLUDED.related_titles, search_text = EXCLUDED.search_text, indexed_at = now()`);
  await buildChunks(db, documentId, d.vid, d.vtitle, d.content as Content);
}

function chunkSections(title: string, content: Content): Array<{ section: string; text: string }> {
  const out: Array<{ section: string; text: string }> = [];
  for (const s of sections(content)) {
    const paras = s.text.split(/\n+/);
    let buf = '';
    for (const p of paras) {
      if ((buf + p).length > 700 && buf) {
        out.push({ section: s.title, text: buf.trim() });
        buf = '';
      }
      buf += p + '\n';
    }
    if (buf.trim()) out.push({ section: s.title, text: buf.trim() });
  }
  if (!out.length) out.push({ section: '本文', text: title });
  return out;
}

/** Chunks + embeddings for AI retrieval. Unchanged chunk text re-uses the cached embedding (no re-embedding). */
export async function buildChunks(db: Db, documentId: string, versionId: string, title: string, content: Content) {
  const existing = await db.one(sql`SELECT count(*)::int AS n FROM knowledge_chunks WHERE version_id = ${versionId}`);
  if (!existing?.n) {
    const chunks = chunkSections(title, content);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const textForEmbed = `${title} ${c.section}\n${c.text}`;
      const h = sha256(textForEmbed);
      const cached = await db.one(sql`SELECT embedding::text AS e FROM embedding_cache WHERE text_hash = ${h} AND model = ${EMBED_MODEL}`);
      const vec = cached?.e ?? toVector(embed(textForEmbed));
      if (!cached) await db.exec(sql`INSERT INTO embedding_cache (text_hash, model, embedding) VALUES (${h}, ${EMBED_MODEL}, ${vec}::vector) ON CONFLICT DO NOTHING`);
      await db.exec(sql`INSERT INTO knowledge_chunks (org_id, document_id, version_id, is_current, ordinal, section, text, text_hash, embedding)
        VALUES (${db.orgId}, ${documentId}, ${versionId}, true, ${i}, ${c.section}, ${c.text}, ${h}, ${vec}::vector)`);
    }
  }
  await db.exec(sql`UPDATE knowledge_chunks SET is_current = (version_id = ${versionId}) WHERE document_id = ${documentId}`);
}

export function likeEscape(s: string) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

export function terms(q: string): string[] {
  return normalizeText(q)
    .split(/[\s　、。,.]+/)
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

export interface SearchFilters {
  type?: string;
  departmentId?: string;
  classification?: string;
  updatedSince?: string;
  category?: string;
  tag?: string;
}

function snippet(body: string, ts: string[]): string {
  const norm = normalizeText(body);
  let pos = -1;
  for (const t of ts) {
    pos = norm.indexOf(t);
    if (pos >= 0) break;
  }
  const start = Math.max(0, pos - 40);
  const s = norm.slice(start, start + 140);
  return (start > 0 ? '…' : '') + s + (start + 140 < norm.length ? '…' : '');
}

export async function searchDocuments(db: Db, actor: Actor, q: string, f: SearchFilters, limit: number, offset: number) {
  const ts = terms(q);
  const conds: SQL[] = [sql`si.org_id = ${db.orgId}`, docReadable(actor, 'd'), raw(`d.status = 'published'`)];
  for (const t of ts) conds.push(sql`si.search_text LIKE ${'%' + likeEscape(t) + '%'}`);
  if (f.type) conds.push(sql`d.type = ${f.type}`);
  if (f.departmentId) conds.push(sql`d.department_id = ${f.departmentId}::uuid`);
  if (f.classification) conds.push(sql`d.classification = ${f.classification}`);
  if (f.updatedSince) conds.push(sql`d.updated_at >= ${f.updatedSince}::date`);
  if (f.category) conds.push(sql`d.category = ${f.category}`);
  if (f.tag) conds.push(sql`${f.tag} = ANY(d.tags)`);
  const nq = normalizeText(q);
  const score = ts.length
    ? sql`(similarity(si.title, ${nq}) * 2 + word_similarity(${nq}, si.search_text) + CASE WHEN lower(si.title) LIKE ${'%' + likeEscape(nq) + '%'} THEN 1 ELSE 0 END)`
    : raw('0');
  const rows = await db.q(sql`
    SELECT d.id, d.doc_number, d.type, d.title, d.classification, d.department_id, dep.name AS department_name, d.category, d.tags,
           d.updated_at, d.next_review_date, v.major, v.minor, v.published_at, si.summary, si.body_text, ${score} AS score,
           count(*) OVER() AS total
      FROM search_index si JOIN documents d ON d.id = si.document_id
      JOIN document_versions v ON v.id = si.version_id
      LEFT JOIN departments dep ON dep.id = d.department_id
     WHERE ${and(conds)}
     ORDER BY score DESC, d.updated_at DESC
     LIMIT ${limit} OFFSET ${offset}`);
  const total = rows[0]?.total ?? 0;
  return {
    total,
    items: rows.map(({ body_text, total: _t, ...r }) => ({ ...r, version: `${r.major}.${r.minor}`, snippet: ts.length ? snippet(body_text, ts) : r.summary })),
  };
}
