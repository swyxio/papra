export type SponsorshipPreset = {
  id: string;
  name: string;
  sourceName: string;
  values: Record<string, string>;
};

export const sponsorshipNumericFields = ['quantity', 'unit-fee', 'line-total', 'total-fee'];

// Accept common pasted money formats, but reject malformed grouping and fractional cents.
export function parseSponsorshipNumber(value: string): number | undefined {
  const text = value.trim().replace(/^\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return;
  const number = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(number) || !Number.isSafeInteger(Math.round(number * 100))) return;
  return number;
}

export function validateSponsorshipNumbers(values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const id of sponsorshipNumericFields) {
    if (!values[id]?.trim()) continue; // Drafts may retain blank placeholders.
    const value = parseSponsorshipNumber(values[id]);
    if (value === undefined)
      errors[id] =
        id === 'quantity'
          ? 'Enter a positive whole quantity.'
          : 'Enter a non-negative amount with at most two decimal places (for example, 20,000.00).';
    else if (id === 'quantity' && (!Number.isSafeInteger(value) || value <= 0))
      errors[id] = 'Enter a positive whole quantity.';
  }
  const quantity = parseSponsorshipNumber(values.quantity ?? '');
  const fee = parseSponsorshipNumber(values['unit-fee'] ?? '');
  const line = parseSponsorshipNumber(values['line-total'] ?? '');
  const total = parseSponsorshipNumber(values['total-fee'] ?? '');
  if (
    !errors.quantity &&
    quantity !== undefined &&
    fee !== undefined &&
    line !== undefined &&
    Math.round(quantity * fee * 100) !== Math.round(line * 100)
  )
    errors['line-total'] =
      'Line total must equal quantity × unit fee. Use Calculate totals to fill it.';
  if (
    line !== undefined &&
    total !== undefined &&
    Math.round(total * 100) !== Math.round(line * 100)
  )
    errors['total-fee'] =
      'For this starter’s single paid placement row, total media fee must equal the line total. Add more rows after creation.';
  return errors;
}

export function sponsorshipCalculatedTotal(values: Record<string, string>): string | undefined {
  const quantity = parseSponsorshipNumber(values.quantity ?? '');
  const fee = parseSponsorshipNumber(values['unit-fee'] ?? '');
  if (
    quantity === undefined ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    fee === undefined
  )
    return;
  const cents = Math.round(quantity * fee * 100);
  if (!Number.isSafeInteger(cents)) return;
  return (cents / 100).toFixed(2);
}
