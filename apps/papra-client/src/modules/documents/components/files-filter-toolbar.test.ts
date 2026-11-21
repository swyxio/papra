import { parseSearchQuery } from '@papra/search-parser';
import { describe, expect, test } from 'vitest';
import { fileSearchQuery, parseFileFilters } from './files-filter.models';

describe('file filters', () => {
  test('applies a chip to the entire typed search, including OR expressions', () => {
    const query = fileSearchQuery('camera OR audio', [{ field: 'uploadedBy', value: 'Casey' }]);
    expect(parseSearchQuery({ query }).expression).toMatchObject({
      type: 'and',
      operands: [
        {
          type: 'or',
          operands: [
            { type: 'text', value: 'camera' },
            { type: 'text', value: 'audio' },
          ],
        },
        { type: 'filter', field: 'uploadedBy', value: 'Casey' },
      ],
    });
  });

  test('restores supported chips from the URL and escapes exact values', () => {
    const filters = parseFileFilters(
      JSON.stringify([
        { field: 'property.cp_stage', value: 'Ready "now" \\ next' },
        { field: 'bad field', value: 'Ignored' },
        { field: 'modifiedBy', value: 123 },
        null,
      ]),
    );
    expect(parseSearchQuery({ query: fileSearchQuery('', filters) }).expression).toMatchObject({
      type: 'filter',
      field: 'property.cp_stage',
      value: 'Ready "now" \\ next',
    });
    expect(parseFileFilters('{broken')).toEqual([]);
    expect(fileSearchQuery('camera OR audio', [])).toBe('camera OR audio');
  });
});
