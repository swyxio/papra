import { expect, test } from 'vitest';
import { validateRecordingNotes } from './recording-notes';

test('sections retain chronology, the ending and verifiable transcript references', () => {
  const source = [
    { id: 0, start: 7, text: 'We queue edits offline.' },
    { id: 1, start: 35, text: 'The queue replays on reconnect.' },
  ];
  const first = {
    title: 'Queue edits while offline',
    summary: 'Edits wait until the connection returns.',
    first: 0,
    witness: 1,
    quote: 'The queue replays on reconnect.',
  };
  expect(validateRecordingNotes({ sections: [first] }, source)).toEqual({
    sections: [
      {
        title: first.title,
        summary: first.summary,
        startSeconds: 7,
        evidence: { startSeconds: 35, quote: first.quote },
      },
    ],
  });
  const ending = { ...first, title: 'Reconnect', first: 1, quote: 'Invented quote.' };
  expect(
    validateRecordingNotes({ sections: [{ ...first, witness: 0 }, ending] }, source).sections,
  ).toMatchObject([
    { startSeconds: 7, evidence: { startSeconds: 7, quote: source[0]!.text } },
    { startSeconds: 35, evidence: { startSeconds: 35, quote: source[1]!.text } },
  ]);
  for (const sections of [
    [{ ...first, first: 1 }],
    [first, { ...ending, first: 0 }],
    [first, ending],
    [first, { ...ending, first: 2 }],
    [{ ...first, witness: 2 }],
  ]) {
    expect(() => validateRecordingNotes({ sections }, source)).toThrow('invalid_recording_summary');
  }
});
