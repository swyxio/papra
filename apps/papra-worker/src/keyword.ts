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
      const fullText =
        'd.id IN (SELECT document_id FROM documents_fts WHERE documents_fts MATCH ?)';
      if (e.type === 'filter') return fullText;
      const escaped = e.value
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_');
      bindings.push(`%${escaped}%`, `%${escaped}%`);
      return `(${fullText} OR EXISTS(SELECT 1 FROM document_custom_properties dp JOIN custom_properties p ON p.id=dp.property_id JOIN json_each(dp.value) pv WHERE dp.document_id=d.id AND p.organization_id=d.organization_id AND (CAST(CASE WHEN p.type='boolean' THEN CASE pv.value WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE '' END ELSE pv.value END AS TEXT) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(coalesce(p.options,'[]')) opt WHERE json_extract(opt.value,'$.id')=pv.value AND json_extract(opt.value,'$.name') LIKE ? ESCAPE '\\'))))`;
    }
    if (e.type === 'filter') {
      if (!['=', '>', '>=', '<', '<='].includes(e.operator))
        throw error(400, 'Unsupported search operator');
      if (e.field.startsWith('property.')) {
        const property = e.field.slice('property.'.length);
        if (!property || !e.value) throw error(400, 'Choose a property and value');
        bindings.push(property, property);
        if (e.operator !== '=') {
          const value = Number(e.value);
          if (!Number.isFinite(value))
            throw error(400, 'Use a numeric value for property comparisons');
          bindings.push(value);
          return `EXISTS(SELECT 1 FROM document_custom_properties dp JOIN custom_properties p ON p.id=dp.property_id WHERE dp.document_id=d.id AND p.organization_id=d.organization_id AND (p.id=? OR lower(p.name)=lower(?)) AND p.type='number' AND CAST(json_extract(dp.value,'$') AS REAL)${e.operator}?)`;
        }
        bindings.push(e.value, e.value);
        return `EXISTS(SELECT 1 FROM document_custom_properties dp JOIN custom_properties p ON p.id=dp.property_id JOIN json_each(dp.value) pv WHERE dp.document_id=d.id AND p.organization_id=d.organization_id AND (p.id=? OR lower(p.name)=lower(?)) AND (lower(CASE WHEN p.type='boolean' THEN CASE pv.value WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE '' END ELSE CAST(pv.value AS TEXT) END)=lower(?) OR EXISTS(SELECT 1 FROM json_each(coalesce(p.options,'[]')) opt WHERE json_extract(opt.value,'$.id')=pv.value AND lower(json_extract(opt.value,'$.name'))=lower(?))))`;
      }
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
