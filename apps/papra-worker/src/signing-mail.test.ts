import { Buffer } from 'node:buffer';
import { describe, expect, test, vi } from 'vitest';
import {
  signedPdfAttachment,
  signedPdfFilename,
  SIGNED_ATTACHMENT_MAX_BYTES,
} from './signing-mail';

describe('signed PDF email attachments', () => {
  test('uses the signing document title consistently without unsafe paths or duplicate suffixes', () => {
    expect(signedPdfFilename('Mutual NDA — Deepgram.pdf')).toBe(
      'Mutual NDA — Deepgram — signed.pdf',
    );
    expect(signedPdfFilename('Offer Letter.PDF.pdf')).toBe('Offer Letter — signed.pdf');
    expect(signedPdfFilename('Offer Letter-signed.pdf')).toBe('Offer Letter — signed.pdf');
    expect(signedPdfFilename('../Invoice: A/B\\C\n.pdf')).toBe('Invoice A B C — signed.pdf');
    expect(signedPdfFilename('.pdf')).toBe('Document — signed.pdf');
    expect(signedPdfFilename('CON.pdf')).toBe('Document — CON — signed.pdf');
    expect(Buffer.byteLength(signedPdfFilename('合同'.repeat(100)))).toBeLessThan(255);
    expect(signedPdfFilename('Cafe\u0301.pdf')).toBe('Café — signed.pdf');
  });

  test('encodes the exact stored sealed bytes and never attaches an incomplete request', async () => {
    const bytes = Buffer.from('%PDF-TEST ONLY-sealed bytes');
    const get = vi.fn(async () => ({
      size: bytes.length,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    const env = { FILES: { get } as unknown as R2Bucket };
    const request = { name: 'TEST ONLY.pdf', signed_key: 'sealed/test.pdf', status: 'completed' };
    const attachment = await signedPdfAttachment(env, request);
    expect(get).toHaveBeenCalledWith('sealed/test.pdf');
    expect(Buffer.from(attachment!.content, 'base64')).toEqual(bytes);
    expect(attachment!.filename).toBe('TEST ONLY — signed.pdf');
    await expect(signedPdfAttachment(env, { ...request, status: 'pending' })).rejects.toThrow(
      'not_ready',
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('oversized PDFs use the link without reading their body; missing PDFs fail for retry', async () => {
    const cancel = vi.fn(async () => {}),
      arrayBuffer = vi.fn();
    const env = {
      FILES: {
        get: vi.fn(async () => ({
          size: SIGNED_ATTACHMENT_MAX_BYTES + 1,
          body: { cancel },
          arrayBuffer,
        })),
      } as unknown as R2Bucket,
    };
    const request = { name: 'Large.pdf', signed_key: 'sealed/large.pdf', status: 'completed' };
    expect(await signedPdfAttachment(env, request)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
    const missing = { FILES: { get: async () => null } as unknown as R2Bucket };
    await expect(signedPdfAttachment(missing, request)).rejects.toThrow('missing');
  });
});
