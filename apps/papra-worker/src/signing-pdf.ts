// Adapted from Documenso's AGPLv3 packages/signing/index.ts and transports/local.ts.
// Source: https://github.com/swyxio/documenso/tree/3849e6317/packages/signing
// LibPDF itself is MIT licensed. Keep Papra's public AGPL source offer.
import { PDF, P12Signer, rgb, measureText } from '@libpdf/core';

import fonts from 'pdfmake/build/vfs_fonts.js';
const fontBytes=(name:string)=>Uint8Array.from(atob(fonts[name]),x=>x.charCodeAt(0));
const textFont=PDF.create().embedFont(fontBytes('Roboto-Regular.ttf'));
export function validateSigningText(value:string){if(!textFont.canEncode(value))throw new Error('This text contains characters outside the supported signing font. Use a supported name or signature.');}

export const SIGNING_MAX_BYTES = 10 * 1024 ** 2;
export const SIGNING_MAX_PAGES = 100;
export type SigningField = {
  id: string; recipient: number; type: 'signature' | 'name' | 'date' | 'text';
  page: number; x: number; y: number; width: number; height: number; label?: string;
};
export async function digestBytes(value: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), x => x.toString(16).padStart(2, '0')).join('');
}
export async function signingPdf(bytes: Uint8Array) {
  if (bytes.length > SIGNING_MAX_BYTES) throw new Error('PDF exceeds the 10 MiB signing limit');
  const pdf = await PDF.load(bytes);
  if (pdf.isEncrypted) throw new Error('Remove the PDF password before requesting signatures');
  if (pdf.getForm()?.getSignatureFields().some(x => x.getSignatureDict())) throw new Error('This PDF already contains a digital signature; upload an unsigned original');
  const pages = pdf.getPages();
  if (!pages.length || pages.length > SIGNING_MAX_PAGES) throw new Error('Signing supports PDFs with 1 to 100 pages');
  // Field geometry uses the actual visible CropBox. Rotation is handled when drawing.
  return pdf;
}
export function validateFields(input: unknown, recipients: number, pages: number): SigningField[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new Error('Add 1 to 100 signing fields');
  const fields = input.map((f, i) => {
    if (!f || !['signature', 'name', 'date', 'text'].includes(f.type) ||
      !Number.isInteger(f.recipient) || f.recipient < 0 || f.recipient >= recipients ||
      !Number.isInteger(f.page) || f.page < 1 || f.page > pages ||
      ![f.x,f.y,f.width,f.height].every(Number.isFinite) ||
      f.x < 0 || f.y < 0 || f.width < .04 || f.height < .018 || f.width > 1 || f.height > 1 ||
      f.x + f.width > 1.000001 || f.y + f.height > 1.000001) throw new Error('Place each field inside a PDF page and assign it to a recipient');
    return { id: `field_${i}`, recipient: f.recipient, type: f.type, page: f.page, x:f.x, y:f.y, width:f.width, height:f.height, label: String(f.label || '').slice(0,80) } as SigningField;
  });
  for (let i=0;i<recipients;i++) if (!fields.some(f => f.recipient === i && f.type === 'signature')) throw new Error('Every recipient needs a signature field');
  return fields;
}
export type PdfSigner = { name: string; email: string; signedAt: number; signature: string; values: Record<string,string>; address: string };
export async function sealSigningPdf(bytes: Uint8Array, fields: SigningField[], recipients: PdfSigner[], audit: { requestId:string; name:string; sourceSha256:string; createdAt:number }, p12: Uint8Array, passphrase: string) {
  const pdf = await signingPdf(bytes);
  const pages = pdf.getPages();
  const regular=pdf.embedFont(fontBytes('Roboto-Regular.ttf')),italic=pdf.embedFont(fontBytes('Roboto-Italic.ttf')),bold=pdf.embedFont(fontBytes('Roboto-Medium.ttf'));
  for (const field of fields) {
    const recipient = recipients[field.recipient];
    const value = field.type === 'signature' ? recipient.signature : field.type === 'name' ? recipient.name : field.type === 'date' ? new Date(recipient.signedAt).toISOString().slice(0,10) : recipient.values[field.id];
    const page=pages[field.page-1], box=page.getCropBox();
    const W=page.rotation % 180 ? box.height : box.width, H=page.rotation % 180 ? box.width : box.height;
    const vx=field.x*W+4, vy=(1-field.y-field.height)*H+Math.max(3,field.height*H*.3);
    // Invert the PDF viewer's clockwise rotation into PDF user coordinates.
    const point=page.rotation===90 ? {x:box.x+box.width-vy,y:box.y+vx} : page.rotation===180 ? {x:box.x+box.width-vx,y:box.y+box.height-vy} : page.rotation===270 ? {x:box.x+vy,y:box.y+box.height-vx} : {x:box.x+vx,y:box.y+vy};
    const font=field.type==='signature' ? italic : regular;
    let fontSize=Math.min(field.type==='signature' ? 22 : 12,field.height*H*.55);
    const width=measureText(value,font,fontSize);
    if (width>field.width*W-8) fontSize*= (field.width*W-8)/width;
    page.drawText(value,{...point,font,size:fontSize,rotate:{angle:page.rotation},color:rgb(.08,.1,.16)});
  }
  // The record is inside the sealed byte range, not merely a detachable JSON log.
  let page=pdf.addPage({size:'letter'}), y=740;
  function line(text:string,isBold=false) {
    const chunks=text.match(/.{1,92}/gu) || [''];
    for(const chunk of chunks) {
      if(y<50){page=pdf.addPage({size:'letter'});y=740;}
      page.drawText(chunk,{x:45,y,size:isBold?14:10,font:isBold?bold:regular});y-=isBold?25:16;
    }
  }
  line('Signing record',true); line(audit.name); line(`Request: ${audit.requestId}`);
  line(`Original SHA-256: ${audit.sourceSha256}`);line(`Sent: ${new Date(audit.createdAt).toISOString()}`);y-=12;
  for(const r of recipients){line(`${r.name} <${r.email}>`,true);line(`Signed: ${new Date(r.signedAt).toISOString()}`);line(`Signature: ${r.signature}`);line(`Network address: ${r.address}`);line('Identity: possession of the signing link; email identity was not independently verified');y-=12;}
  line('Each signer consented to electronic signing and adopted the entered name as their signature.');
  const signer=await P12Signer.create(p12,passphrase,{buildChain:false});
  const result=await pdf.sign({signer,reason:'Electronically signed through swyx Drive',location:'https://drive.swyx.io',subFilter:'ETSI.CAdES.detached'});
  return result.bytes;
}
