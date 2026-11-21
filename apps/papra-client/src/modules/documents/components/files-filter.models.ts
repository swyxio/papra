export type FileFilter = { field: string; value: string };

export function parseFileFilters(raw: string | string[] | undefined): FileFilter[] {
  if (typeof raw !== 'string' || raw.length > 8192) return [];
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    return decoded.filter(
      (value): value is FileFilter =>
        value !== null &&
        typeof value === 'object' &&
        typeof value.field === 'string' &&
        /^(uploadedBy|modifiedBy|property\.[\w-]+)$/.test(value.field) &&
        typeof value.value === 'string' &&
        Boolean(value.value.trim()),
    );
  } catch {
    return [];
  }
}

export function fileSearchQuery(text: string, filters: FileFilter[]) {
  if (!filters.length) return text;
  const terms = filters.map(
    ({ field, value }) => `${field}:"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
  );
  if (text.trim()) terms.unshift(`(${text.trim()})`);
  return terms.join(' ');
}
