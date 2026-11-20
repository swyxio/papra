import { expect, test } from 'vitest';
import { cleanSuggestedName, excerptOf, validateRenameSuggestions } from './rename-suggestions';

test('suggested names keep the original extension and drop unsafe characters', () => {
  expect(cleanSuggestedName('Keynote: Agents / Evals', 'C4125.MP4')).toBe(
    'Keynote Agents Evals.MP4',
  );
  expect(cleanSuggestedName('Sponsor deck.pdf', 'deck.pdf')).toBe('Sponsor deck.pdf');
  expect(cleanSuggestedName('Notes', 'untitled')).toBe('Notes');
  expect(cleanSuggestedName('  /// ', 'a.wav')).toBe('');
});

test('suggestions are limited to requested files, deduplicated and bounded', () => {
  const sources = [
    { id: 'doc_1', name: '00048_Mic2.wav', mimeType: 'audio/wav', folder: 'Home', excerpt: 'hi' },
  ];
  expect(
    validateRenameSuggestions(
      {
        suggestions: [
          { id: 'doc_1', name: 'Swyx intro mic', description: 'x'.repeat(400) },
          { id: 'doc_1', name: 'Duplicate', description: '' },
          { id: 'doc_other', name: 'Injected', description: '' },
        ],
      },
      sources,
    ),
  ).toEqual([{ documentId: 'doc_1', name: 'Swyx intro mic.wav', description: 'x'.repeat(300) }]);
  expect(validateRenameSuggestions({ nope: true }, sources)).toEqual([]);
});

test('excerpts collapse whitespace and truncate', () => {
  expect(excerptOf('  a \n\n b ')).toBe('a b');
  expect(excerptOf('x'.repeat(3000))).toHaveLength(2501);
  expect(excerptOf(null)).toBe('');
});
