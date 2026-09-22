import { expect, test } from 'vitest';
import {
  companyNameForOrganization,
  presentTemplate,
  templateDefaults,
} from './template-presentation';
import { fillTemplate } from './document-templates';
import type { DocumentTemplate } from './document-templates';

const fixture = (): DocumentTemplate => ({
  id: 'mutual-nda',
  name: 'NDA',
  url: '',
  preparedAt: '',
  originalSha256: '',
  guidance: '',
  fields: [
    {
      id: 'company-name',
      label: 'Company name',
      marker: '{{company-name}}',
      original: '[Company Name]',
    },
    {
      id: 'counterparty-name',
      label: 'Counterparty',
      marker: '{{counterparty-name}}',
      original: '[Counterparty]',
    },
  ],
  source: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '{{company-name}}' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Mutual NDA', marks: [{ type: 'underline' }] }],
      },
      {
        type: 'paragraph',
        attrs: { pageBreakBefore: true },
        content: [
          { type: 'text', text: '1. ' },
          { type: 'text', text: 'Confidentiality.', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' Keep these exact words.' },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'THE COMPANY:' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Name: ' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'COUNTERPARTY:' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Name: ' }] },
    ],
  },
});

test('restores headings without dropping clause text, duplicating page breaks, or editing the original', () => {
  const original = fixture(),
    source = JSON.stringify(original);
  const result = presentTemplate(original);
  expect(result.source.content?.[1].type).toBe('heading');
  expect(result.source.content?.[1].content?.[0].marks).toEqual([]);
  expect(result.source.content?.[2].attrs?.pageBreakBefore).toBe(true);
  expect(result.source.content?.[3].attrs?.pageBreakBefore).toBeUndefined();
  expect(
    (result.source.content?.[2].content?.map((n) => n.text).join('') ?? '') +
      (result.source.content?.[3].content?.map((n) => n.text).join('') ?? ''),
  ).toBe('1. Confidentiality. Keep these exact words.');
  expect(JSON.stringify(original)).toBe(source);
});

test('defaults company and its signatory only; edits and explicit clears override defaults', () => {
  const template = presentTemplate(fixture());
  const defaults = templateDefaults(template, companyNameForOrganization('Smol'), 'Shawn Wang');
  expect(defaults).toEqual({
    'company-name': 'Smol AI Company',
    'company-signatory-name': 'Shawn Wang',
  });
  expect(companyNameForOrganization('LS')).toBe('Swyx Inc');
  expect(companyNameForOrganization('Latent Space')).toBe('Swyx Inc');
  expect(companyNameForOrganization('AIE')).toBe('Software 3.0 Inc');
  expect(companyNameForOrganization('Personal')).toBe('');
  const filled = fillTemplate(template, { ...defaults, 'company-name': '' });
  expect(filled.content?.[0].content?.[0].text).toBe('[Company Name]');
  expect(
    filled.content
      ?.at(-1)
      ?.content?.map((n) => n.text)
      .join(''),
  ).toBe('Name: ');
});
