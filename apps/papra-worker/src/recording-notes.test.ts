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
    last: 1,
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
  for (const section of [
    { ...first, first: 1 },
    { ...first, last: 0, witness: 0, quote: source[0]!.text },
    { ...first, quote: 'Invented quote.' },
    { ...first, witness: 2 },
    { ...first, last: 2 },
  ]) {
    expect(() => validateRecordingNotes({ sections: [section] }, source)).toThrow(
      'invalid_recording_summary',
    );
  }
});
