import type { JSONContent } from '@tiptap/core';
import type { TemplateField } from './document-templates';
import { sponsorshipOrder } from './sponsorship-order';

const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
const heading = (text: string): JSONContent => ({
  type: 'heading',
  attrs: { level: 1 },
  content: [{ type: 'text', text }],
});
const cell = (text: string, header = false): JSONContent => ({
  type: header ? 'tableHeader' : 'tableCell',
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(text)],
});
export const documentStarters: {
  id: string;
  name: string;
  source: JSONContent;
  fields?: TemplateField[];
}[] = [
  sponsorshipOrder,
  { id: 'blank', name: 'Blank document', source: { type: 'doc', content: [paragraph('')] } },
  {
    id: 'invoice',
    name: 'Invoice',
    source: {
      type: 'doc',
      content: [
        heading('Invoice'),
        paragraph('Invoice number: [number]'),
        paragraph('From: [your name or company]'),
        paragraph('Bill to: [customer]'),
        paragraph('Date: [date] · Due: [due date]'),
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('Description', true), cell('Quantity', true), cell('Amount', true)],
            },
            { type: 'tableRow', content: [cell('[Service or item]'), cell('1'), cell('[Amount]')] },
            { type: 'tableRow', content: [cell('Total'), cell(''), cell('[Total]')] },
          ],
        },
        paragraph('Payment instructions: [details]'),
        paragraph('Notes: [optional notes]'),
      ],
    },
  },
  {
    id: 'agreement',
    name: 'Agreement outline',
    source: {
      type: 'doc',
      content: [
        heading('Agreement'),
        paragraph('Draft — replace the placeholders and review the terms before sending.'),
        paragraph('Parties: [party one] and [party two]'),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope' }] },
        paragraph('[Describe the work, deliverables, and responsibilities.]'),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Terms' }] },
        paragraph('[Add dates, payment terms, and other agreed conditions.]'),
        paragraph('Signatures:'),
      ],
    },
  },
];
