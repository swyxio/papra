import { parseSearchQuery } from '@papra/search-parser';
import type { Expression } from '@papra/search-parser';
import { error } from './db';

export function keywordPredicate(query: string) {
  if (query.length > 4000) throw error(400, 'Search query is too long');
  const parsed = parseSearchQuery({ query, maxDepth: 20, maxTokens: 100 });
  if (parsed.issues.length) throw error(400, parsed.issues[0].message);
  const bindings: (string | number)[] = [];
  function compile(e: Expression, depth = 0): string {
    if (depth > 20 || bindings.length > 60) throw error(400, 'Search query is too complex');
    if (e.type === 'empty') return '1';
    if (e.type === 'and' || e.type === 'or')
      return `(${e.operands.map((x) => compile(x, depth + 1)).join(e.type === 'and' ? ' AND ' : ' OR ')})`;
    if (e.type === 'not') return `NOT (${compile(e.operand, depth + 1)})`;
    if (
      e.type === 'text' ||
      (e.type === 'filter' && ['name', 'content', 'notes'].includes(e.field))
    ) {
      const column = e.type === 'filter' ? `${e.field}: ` : '';
      bindings.push(`${column}"${e.value.replaceAll('"', '""')}"*`);
      return 'd.id IN (SELECT document_id FROM documents_fts WHERE documents_fts MATCH ?)';
    }
    if (e.type === 'filter') {
      if (!['=', '>', '>=', '<', '<='].includes(e.operator))
        throw error(400, 'Unsupported search operator');
      if (e.field === 'tag') {
        bindings.push(e.value, e.value);
        return 'EXISTS(SELECT 1 FROM documents_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id AND (t.id=? OR lower(t.name)=lower(?)))';
      }
      if (e.field === 'has') {
        if (e.value === 'tags')
          return 'EXISTS(SELECT 1 FROM documents_tags dt WHERE dt.document_id=d.id)';
        if (e.value === 'date') return 'd.document_date IS NOT NULL';
        throw error(400, 'Unsupported has filter');
      }
      if (['date', 'created'].includes(e.field)) {
        const stamp = Date.parse(e.value);
        if (!Number.isFinite(stamp)) throw error(400, 'Use an ISO date in date filters');
        const column = e.field === 'date' ? 'document_date' : 'created_at';
        if (e.operator === '=') {
          bindings.push(stamp, stamp + 86400000);
          return `(d.${column}>=? AND d.${column}<?)`;
        }
        bindings.push(stamp);
        return `d.${column}${e.operator}?`;
      }
      throw error(400, `Unsupported search field: ${e.field}`);
    }
    return '0';
  }
  return { sql: compile(parsed.expression), bindings };
}
