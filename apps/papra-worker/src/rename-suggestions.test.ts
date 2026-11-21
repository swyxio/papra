import type { Env } from './types';
import { expect, test, vi } from 'vitest';
import {
  cleanSuggestedName,
  excerptOf,
  readRenameFrames,
  suggestDocumentNames,
  validateRenameSuggestions,
  withNearbySpeech,
} from './rename-suggestions';

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
  ).toEqual([
    { documentId: 'doc_1', name: 'Swyx intro mic - Mic2.wav', description: 'x'.repeat(300) },
  ]);
  expect(validateRenameSuggestions({ nope: true }, sources)).toEqual([]);
});

test('excerpts collapse whitespace and truncate', () => {
  expect(excerptOf('  a \n\n b ')).toBe('a b');
  expect(excerptOf('x'.repeat(3000))).toHaveLength(2501);
  expect(excerptOf(null)).toBe('');
});

test('camera and clip labels survive suggestions that omit or guess them', () => {
  expect(cleanSuggestedName('Pragmatic Engineer Wide Shot', 'Untitled CAM 4 01.mp4')).toBe(
    'Pragmatic Engineer Wide Shot - CAM 4 01.mp4',
  );
  expect(cleanSuggestedName('Interview - Camera 9 - Take 3', 'CAM_1 Take 02.MP4')).toBe(
    'Interview - CAM_1 - Take 02.MP4',
  );
  expect(cleanSuggestedName('Interview CAM 2', 'Untitled CAM 2.mp4')).toBe('Interview - CAM 2.mp4');
});

test('recording excerpts include speech from the beginning, middle, and end', () => {
  const recording =
    'Opening Credits ' +
    'a'.repeat(4990) +
    ' Camera context ' +
    'b'.repeat(4990) +
    ' Closing Credits';
  const excerpt = excerptOf(recording, true);
  expect(excerpt).toContain('Opening Credits');
  expect(excerpt).toContain('Camera context');
  expect(excerpt).toContain('Closing Credits');
  expect(excerpt.length).toBeLessThanOrEqual(7506);
});

test('filename-only suggestions preserve camera and clip labels without model calls or filler', async () => {
  const run = vi.fn();
  const env = { AI: { run } } as unknown as Env;
  const sources = ['Untitled CAM 4 01.mp4', 'Untitled CAM 2 01.MP4', 'Interview Edit CAM 4.mp4'];
  const result = await suggestDocumentNames(
    env,
    sources.map((name, i) => ({
      id: String(i),
      name,
      mimeType: 'video/mp4',
      folder: 'Home / Pragmatic Engineer <> Swyx',
      excerpt: '',
      frames: [],
    })),
  );
  expect(run).not.toHaveBeenCalled();
  expect(result).toEqual([
    { documentId: '0', name: 'Pragmatic Engineer + Swyx - CAM 4 01.mp4', description: '' },
    { documentId: '1', name: 'Pragmatic Engineer + Swyx - CAM 2 01.MP4', description: '' },
    { documentId: '2', name: 'Interview Edit CAM 4.mp4', description: '' },
  ]);
});

test('rename reads bounded cached frames and adds them to one request for the same recording', async () => {
  const thumbnails = [0, 20, 40, 60, 80].map((timestamp_seconds) => ({
    timestamp_seconds,
    storage_key: `thumb-${timestamp_seconds}`,
  }));
  const bind = vi.fn(() => ({ all: async () => ({ results: thumbnails }) }));
  const storage = vi.fn(async (key: string) =>
    key === 'thumb-40'
      ? null
      : {
          size: 3,
          arrayBuffer: async () => Uint8Array.of(1, 2, 3).buffer,
        },
  );
  const run = vi.fn(async (_model: string, _input: unknown) => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            suggestions: [
              { id: 'video', name: 'Camera two-shot', description: 'Two people on camera.' },
            ],
          }),
        },
      },
    ],
  }));
  const env = {
    DB: { prepare: () => ({ bind }) },
    FILES: { get: storage },
    AI: { run },
  } as unknown as Env;
  const frames = await readRenameFrames(env, 'version');
  expect(bind).toHaveBeenCalledWith('version', 256 * 1024);
  expect(storage.mock.calls.map(([key]) => key)).toEqual(['thumb-20', 'thumb-40', 'thumb-60']);
  const result = await suggestDocumentNames(env, [
    {
      id: 'video',
      name: 'Untitled CAM 1.mp4',
      mimeType: 'video/mp4',
      folder: 'Interview',
      excerpt: 'Introductions and the rest of the conversation',
      frames: withNearbySpeech(frames, [
        { text: '[Chunk 1 not transcribed]', startSeconds: null },
        { text: 'Opening introduction', startSeconds: 2 },
        { text: 'Self-introduction', startSeconds: 19 },
        { text: 'Unrelated section', startSeconds: 45 },
      ]),
    },
  ]);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[1]).toMatchObject({
    messages: [
      { role: 'system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: expect.stringContaining('Introductions') },
          { type: 'text', text: 'Frame at 20s. Nearby transcript excerpt: "Self-introduction"' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
          { type: 'text', text: 'Frame at 60s' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
        ],
      },
    ],
  });
  expect(result[0]?.name).toBe('Camera two-shot - CAM 1.mp4');
});
