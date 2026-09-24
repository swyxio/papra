import { expect, test } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { fillTemplate } from './document-templates';
import { sponsorshipOrder } from './sponsorship-order';
import { documentStarters } from './document-starters';
import { describeTemplate } from './template-descriptions';
import { companyNameForOrganization, templateDefaults } from './template-presentation';

test('sponsorship orders separate advertiser, agency, paying entity and signatory without reusing customer data', () => {
  const snapshot = JSON.stringify(sponsorshipOrder);
  const defaults = templateDefaults(
    sponsorshipOrder,
    companyNameForOrganization('LS'),
    'Test Publisher',
  );
  const source = fillTemplate(sponsorshipOrder, {
    ...defaults,
    'advertiser-name': 'TEST Advertiser',
    'agency-name': 'TEST Agency',
    'paying-entity': 'TEST Paying Entity',
    'buyer-signatory-name': 'TEST Buyer',
    'deliverables': 'First placement\nSecond placement',
  });
  const text = JSON.stringify(source);
  for (const value of [
    'TEST Advertiser',
    'TEST Agency',
    'TEST Paying Entity',
    'TEST Buyer',
    'Swyx Inc',
    'Test Publisher',
  ])
    expect(text).toContain(value);
  expect(text).toContain('First placement\\nSecond placement');
  expect(text).not.toContain('{{');
  expect(defaults).not.toHaveProperty('buyer-signatory-name');
  expect(snapshot).not.toMatch(/Deepgram|Transmission|80,000|Tian Richards|shawnthe1@gmail.com/);
  expect(JSON.stringify(sponsorshipOrder)).toBe(snapshot);
  const fields = sponsorshipOrder.fields.map((f) => f.id);
  expect(new Set(fields).size).toBe(fields.length);
  const markers = JSON.stringify(sponsorshipOrder.source).match(/\{\{[a-z0-9-]+\}\}/g)!;
  expect(new Set(markers)).toEqual(new Set(sponsorshipOrder.fields.map((f) => f.marker)));
});

test('sponsorship order is a distinct described template and does not replace the invoice', () => {
  expect(documentStarters.find((t) => t.id === 'sponsorship-order')).toBe(sponsorshipOrder);
  expect(documentStarters.find((t) => t.id === 'invoice')?.name).toBe('Invoice');
  expect(describeTemplate('sponsorship-order', '')).toMatchObject({
    title: 'Sponsorship Order',
    description: 'Define deliverables, dates, pricing, and terms, then send for signature.',
  });
});

test('every starter opens in the editor schema, including empty invoice and order table cells', () => {
  const schema = getSchema([StarterKit, TableKit]);
  for (const starter of documentStarters) {
    const source = starter.fields
      ? fillTemplate({ source: starter.source, fields: starter.fields }, {})
      : starter.source;
    const document = schema.nodeFromJSON(source);
    expect(() => document.check()).not.toThrow();
    if (starter.id === 'sponsorship-order')
      expect(document.textContent).toContain('Sponsorship Order');
  }
});
