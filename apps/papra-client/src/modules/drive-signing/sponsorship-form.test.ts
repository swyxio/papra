import { expect, test } from 'vitest';
import {
  parseSponsorshipNumber,
  sponsorshipCalculatedTotal,
  validateSponsorshipNumbers,
} from './sponsorship-form';

test('accepts pasted money and rejects malformed, negative, fractional-cent and non-finite amounts', () => {
  for (const value of ['20000', '20,000', '$20,000.00'])
    expect(parseSponsorshipNumber(value)).toBe(20000);
  expect(parseSponsorshipNumber('0')).toBe(0);
  for (const value of [
    '-1',
    '20,00',
    '12.001',
    'NaN',
    'Infinity',
    '1e4',
    '1 2',
    '999999999999999999',
  ])
    expect(parseSponsorshipNumber(value)).toBeUndefined();
});

test('allows incomplete drafts, checks positive integer quantity, and reconciles fees', () => {
  expect(validateSponsorshipNumbers({})).toEqual({});
  for (const quantity of ['0', '-1', '1.5', 'no'])
    expect(validateSponsorshipNumbers({ quantity }).quantity).toBeTruthy();
  const values = {
    'quantity': '4',
    'unit-fee': '$20,000',
    'line-total': '80,000',
    'total-fee': '80000.00',
  };
  expect(validateSponsorshipNumbers(values)).toEqual({});
  expect(sponsorshipCalculatedTotal(values)).toBe('80000.00');
  expect(
    validateSponsorshipNumbers({ ...values, 'line-total': '20,000' })['line-total'],
  ).toBeTruthy();
  expect(validateSponsorshipNumbers({ ...values, 'total-fee': '8000' })['total-fee']).toBeTruthy();
  expect(validateSponsorshipNumbers({ ...values, 'unit-fee': '-10' })['unit-fee']).toBeTruthy();
  expect(sponsorshipCalculatedTotal({ 'quantity': '3', 'unit-fee': '0.10' })).toBe('0.30');
  expect(sponsorshipCalculatedTotal({ 'quantity': '1.5', 'unit-fee': '100' })).toBeUndefined();
  expect(sponsorshipCalculatedTotal({ 'quantity': '4', 'unit-fee': '0' })).toBe('0.00');
});
