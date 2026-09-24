import type { JSONContent } from '@tiptap/core';
import type { FillableTemplate, TemplateField } from './document-templates';
import { fillTemplate } from './document-templates';

export const employmentChanges = [
  { value: 'layoff', label: 'Layoff' },
  { value: 'discharge', label: 'Discharge' },
  { value: 'leave', label: 'Leave of absence' },
  { value: 'other', label: 'Other employment status change' },
];
const paragraph = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const fields: TemplateField[] = [
  {
    id: 'employee-name',
    label: 'Employee name',
    section: 'Employee',
    marker: '{{employee-name}}',
    original: '[Employee name]',
  },
  {
    id: 'employee-ssn',
    label: 'Employee SSN',
    marker: '{{employee-ssn}}',
    original: '___-__-____',
    inputType: 'password',
  },
  {
    id: 'change-type',
    label: 'Change type',
    section: 'Change in relationship',
    marker: '{{change-type}}',
    original: '[Select change type]',
    options: employmentChanges,
  },
  {
    id: 'effective-date',
    label: 'Effective date',
    marker: '{{effective-date}}',
    original: '[Effective date]',
    inputType: 'date',
  },
  {
    id: 'change-details',
    label: 'Description of change',
    marker: '{{change-details}}',
    original: '[Describe the employment status change]',
    multiline: true,
  },
  {
    id: 'company-name',
    label: 'Employer legal name',
    section: 'Employer',
    marker: '{{company-name}}',
    original: '[Employer legal name]',
  },
  {
    id: 'company-signatory-name',
    label: 'Employer representative name',
    marker: '{{company-signatory-name}}',
    original: '[Employer representative name]',
  },
  {
    id: 'company-signatory-title',
    label: 'Employer representative title',
    marker: '{{company-signatory-title}}',
    original: '[Title]',
  },
];

export const employmentChangeNotice: FillableTemplate & { id: string; name: string } = {
  id: 'employment-change-ca',
  name: 'California Employment Change Notice',
  fields,
  source: {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Notice to Employee as to Change in Relationship' }],
      },
      paragraph('Issued pursuant to Section 1089 of the California Unemployment Insurance Code'),
      paragraph('Employee: {{employee-name}}'),
      paragraph('Social Security number: {{employee-ssn}}'),
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: '{{change-type}}' }],
      },
      paragraph('{{effective-date}}'),
      paragraph('{{change-details}}'),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Employer' }] },
      paragraph('{{company-name}}'),
      paragraph('By: {{company-signatory-name}}'),
      paragraph('Title: {{company-signatory-title}}'),
      paragraph('Employer signature: ____________________________________'),
      paragraph('Date signed: __________________________________________'),
    ],
  },
};

export function validateEmploymentNotice(values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  const ssn = values['employee-ssn']?.trim();
  // Format and obvious invalid groups only; this does not verify an issued SSN.
  if (
    ssn &&
    (!/^(\d{9}|\d{3}-\d{2}-\d{4})$/.test(ssn) ||
      /^(000|666|9\d\d)/.test(ssn) ||
      /^\d{3}-?00/.test(ssn) ||
      /0000$/.test(ssn))
  )
    errors['employee-ssn'] = 'Enter nine digits or XXX-XX-XXXX, with valid number groups.';
  const date = values['effective-date'];
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    errors['effective-date'] = 'Enter a valid effective date.';
  return errors;
}

export function employmentNoticeSource(values: Record<string, string>): JSONContent {
  const type = values['change-type'];
  const label =
    employmentChanges.find((change) => change.value === type)?.label ?? '[Select change type]';
  const source = fillTemplate(employmentChangeNotice, {
    ...values,
    'change-type': label,
    'employee-ssn': values['employee-ssn']?.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3') ?? '',
  });
  const date = values['effective-date'] || '[Effective date]';
  const statement =
    type === 'layoff'
      ? `You were/will be laid off on ${date}.`
      : type === 'discharge'
        ? `You were/will be discharged on ${date}.`
        : type === 'leave'
          ? `You were/will be on leave of absence starting ${date}.`
          : `On ${date}, your employment status changed/will change as follows:`;
  source.content![5] = paragraph(statement);
  if (type !== 'other') source.content!.splice(6, 1);
  return source;
}
