import { expect, test } from 'vitest';
import { fillTemplate } from './document-templates';
import type { DocumentTemplate } from './document-templates';

test('fills repeated fields once, retains blanks and does not interpret user input as markers', () => {
  const template = {
    source: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '{{company}} and {{company}}: {{date}}',
              marks: [{ type: 'bold' }],
            },
          ],
        },
      ],
    },
    fields: [
      { id: 'company', marker: '{{company}}', original: '[Company Name]' },
      { id: 'date', marker: '{{date}}', original: '[Date]' },
    ],
  } as DocumentTemplate;
  const result = fillTemplate(template, { company: 'Test {{date}} <b>Company</b>' });
  expect(result.content![0].content![0].text).toBe(
    'Test {{date}} <b>Company</b> and Test {{date}} <b>Company</b>: [Date]',
  );
  expect(result.content![0].content![0].marks).toEqual([{ type: 'bold' }]);
  expect(template.source.content![0].content![0].text).toBe(
    '{{company}} and {{company}}: {{date}}',
  );
});
