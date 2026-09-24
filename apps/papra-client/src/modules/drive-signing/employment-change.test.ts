import { expect, test } from 'vitest';
import {
  employmentChangeNotice,
  employmentNoticeSource,
  validateEmploymentNotice,
} from './employment-change';
import { templateDefaults } from './template-presentation';

test('all employment changes produce only the selected notice and employer signature', () => {
  const defaults = templateDefaults(employmentChangeNotice, 'TEST Employer', 'TEST Representative');
  expect(defaults).not.toHaveProperty('employee-ssn');
  expect(defaults).not.toHaveProperty('employee-name');
  for (const [type, statement] of [
    ['layoff', 'laid off'],
    ['discharge', 'discharged'],
    ['leave', 'leave of absence'],
    ['other', 'employment status changed'],
  ] as const) {
    const text = JSON.stringify(
      employmentNoticeSource({
        ...defaults,
        'employee-name': 'TEST Employee',
        'employee-ssn': '123456789',
        'change-type': type,
        'effective-date': '2026-10-01',
        'change-details': 'TEST status description',
      }),
    );
    expect(text).toContain(statement);
    expect(text).toContain('2026-10-01');
    expect(text).toContain('123-45-6789');
    expect(text).toContain('TEST Employer');
    expect(text).toContain('TEST Representative');
    expect(text).toContain('Employer signature: ____');
    expect(text).not.toMatch(/Employee signature|Acknowledgment|SAMPLE/);
    expect(text.includes('TEST status description')).toBe(type === 'other');
  }
  expect(JSON.stringify(employmentChangeNotice)).not.toContain('123-45-6789');
});

test('manual SSNs and calendar dates reject malformed values without guessing real identifiers', () => {
  expect(validateEmploymentNotice({})).toEqual({}); // Blank draft placeholders are allowed.
  for (const ssn of ['123456789', '123-45-6789'])
    expect(validateEmploymentNotice({ 'employee-ssn': ssn })).toEqual({});
  for (const ssn of [
    '1234',
    '123-45-678',
    'abc',
    '000-12-3456',
    '666-12-3456',
    '900-12-3456',
    '123-00-4567',
    '123-45-0000',
  ])
    expect(validateEmploymentNotice({ 'employee-ssn': ssn })).toHaveProperty('employee-ssn');
  expect(validateEmploymentNotice({ 'effective-date': '2026-02-30' })).toHaveProperty(
    'effective-date',
  );
  expect(validateEmploymentNotice({ 'effective-date': '2028-02-29' })).toEqual({});
});
