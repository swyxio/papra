import type { JSONContent } from '@tiptap/core';
import type { FillableTemplate, TemplateField } from './document-templates';

const fields: TemplateField[] = [];
function field(id: string, label: string, section?: string, multiline = false) {
  fields.push({ id, label, marker: `{{${id}}}`, original: `[${label}]`, section, multiline });
  return `{{${id}}}`;
}
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
const heading = (text: string, level = 2): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const detail = (label: string, value: string): JSONContent => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: `${label}: `, marks: [{ type: 'bold' }] },
    { type: 'text', text: value },
  ],
});
const cell = (text: string, header = false): JSONContent => ({
  type: header ? 'tableHeader' : 'tableCell',
  attrs: { colspan: 1, rowspan: 1 },
  content: [paragraph(text)],
});

// Reusable structure from the owner's insertion order; no customer, price, or signature is saved.
export const sponsorshipOrder: FillableTemplate & { id: string; name: string } = {
  id: 'sponsorship-order',
  name: 'Sponsorship Order',
  fields,
  source: {
    type: 'doc',
    content: [
      heading('Sponsorship Order', 1),
      paragraph(field('campaign-name', 'Campaign name', 'Order details')),
      paragraph('Sponsorship insertion order (IO)'),
      heading('01  Order details'),
      detail('IO reference', field('order-reference', 'IO reference')),
      detail('Order date', field('order-date', 'Order date')),
      detail('Publisher', field('company-name', 'Publisher legal name')),
      detail('Publisher address', field('publisher-address', 'Publisher address')),
      detail('Publisher contact', field('publisher-contact', 'Publisher contact and email')),
      detail('Advertiser', field('advertiser-name', 'Advertiser name')),
      detail('Agency', field('agency-name', 'Agency, if applicable')),
      detail('Buyer contact', field('buyer-contact', 'Buyer contact and email')),
      detail(
        'Contracting and paying entity',
        field('paying-entity', 'Contracting and paying entity'),
      ),
      heading('02  Placements and fees'),
      detail('Currency', field('currency', 'Currency', 'Placements and fees')),
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: ['Placement and distribution', 'Qty', 'Unit fee', 'Line total'].map((text) =>
              cell(text, true),
            ),
          },
          {
            type: 'tableRow',
            content: [
              field('placement', 'Placement and distribution', undefined, true),
              field('quantity', 'Quantity'),
              field('unit-fee', 'Unit fee'),
              field('line-total', 'Line total'),
            ].map((text) => cell(text)),
          },
          {
            type: 'tableRow',
            content: [
              cell('Total media fee'),
              cell(''),
              cell(''),
              cell(field('total-fee', 'Total media fee')),
            ],
          },
        ],
      },
      detail(
        'Included placements',
        field('included-placements', 'Included placements, if any', undefined, true),
      ),
      heading('03  Schedule'),
      detail(
        'Campaign window',
        field('campaign-window', 'Campaign window and excluded dates', 'Schedule', true),
      ),
      detail(
        'Publication dates',
        field('publication-dates', 'Publication dates or scheduling agreement', undefined, true),
      ),
      heading('04  Billing'),
      detail(
        'Payment schedule',
        field('payment-schedule', 'Payment milestones, amounts and due dates', 'Billing', true),
      ),
      detail('Buyer billing address', field('billing-address', 'Buyer billing address')),
      detail('Invoice email', field('invoice-email', 'Invoice email')),
      detail(
        'PO and billing requirements',
        field('po-requirements', 'PO and billing requirements', undefined, true),
      ),
      heading('05  Deliverables and production'),
      detail(
        'Deliverables',
        field('deliverables', 'Deliverables and distribution', 'Delivery and approval', true),
      ),
      detail(
        'Materials and deadlines',
        field('materials', 'Materials and copy deadlines', undefined, true),
      ),
      detail(
        'Approval process',
        field('approval-process', 'Approval process and contacts', undefined, true),
      ),
      detail(
        'Exclusivity',
        field('exclusivity', 'Agreed exclusivity scope, or none', undefined, true),
      ),
      heading('06  Reporting and editorial independence'),
      detail(
        'Reporting',
        field(
          'reporting',
          'Metrics, reporting windows and delivery dates',
          'Reporting and terms',
          true,
        ),
      ),
      detail(
        'Editorial and performance terms',
        field(
          'editorial-terms',
          'Editorial control, disclosure and performance commitments',
          undefined,
          true,
        ),
      ),
      heading('07  Applicable terms'),
      detail(
        'Cancellation, rescheduling and missed placements',
        field(
          'cancellation-terms',
          'Cancellation, rescheduling and missed placements',
          undefined,
          true,
        ),
      ),
      detail(
        'Other agreed terms',
        field('other-terms', 'Other agreed terms or referenced agreement', undefined, true),
      ),
      heading('08  Authorised signatures'),
      paragraph(
        'The parties agree to the placements, fees and terms set out in this sponsorship order.',
      ),
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [cell('For {{company-name}}', true), cell('For {{paying-entity}}', true)],
          },
          {
            type: 'tableRow',
            content: [
              cell('Signature: ____________________'),
              cell('Signature: ____________________'),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell(
                `Name: ${field('company-signatory-name', 'Publisher signatory name', 'Signatories')}`,
              ),
              cell(`Name: ${field('buyer-signatory-name', 'Buyer signatory name')}`),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell(`Title: ${field('company-signatory-title', 'Publisher signatory title')}`),
              cell(`Title: ${field('buyer-signatory-title', 'Buyer signatory title')}`),
            ],
          },
          {
            type: 'tableRow',
            content: [
              cell('Date: ________________________'),
              cell('Date: ________________________'),
            ],
          },
        ],
      },
    ],
  },
};
