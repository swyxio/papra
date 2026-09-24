import type { JSONContent } from '@tiptap/core';
import type { DocumentTemplate } from './document-templates';

const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join('');
const heading = (node: JSONContent, level: number): JSONContent => ({
  ...node,
  type: 'heading',
  attrs: { ...node.attrs, level },
  content: node.content?.map((run) => ({
    ...run,
    marks: run.marks?.filter((mark) => mark.type !== 'underline'),
  })),
});

// Restore hierarchy lost by the DOCX importer. Keep every word and existing page break.
export function presentTemplate(input: DocumentTemplate): DocumentTemplate {
  const template = structuredClone(input);
  function cleanUnderline(node: JSONContent) {
    if (node.text?.match(/[a-z]/i))
      node.marks = node.marks?.filter((mark) => mark.type !== 'underline');
    node.content?.forEach(cleanUnderline);
  }
  cleanUnderline(template.source);
  let companySection = false;
  let signatoryAdded = false;
  if (template.id === 'employee-assignment-ca') {
    const table = template.source.content?.find(
      (node) =>
        node.type === 'table' &&
        text(node).includes('EMPLOYER:') &&
        text(node).includes('EMPLOYEE:'),
    );
    const rows = table?.content ?? [];
    const printedName = rows.findIndex((row) => text(row).includes('(Printed Name)'));
    if (printedName > 0) {
      for (const [column, id, label] of [
        [0, 'company-signatory-name', 'Company signatory name'],
        [2, 'employee-name', 'Employee name'],
      ] as const) {
        const cell = rows[printedName - 1].content?.[column];
        if (cell && !text(cell).trim()) {
          cell.content = [{ type: 'paragraph', content: [{ type: 'text', text: `{{${id}}}` }] }];
          template.fields.push({
            id,
            label,
            marker: `{{${id}}}`,
            original: '____________________',
          });
        }
      }
    }
  }
  template.source.content = template.source.content?.flatMap((node, index) => {
    const copy = text(node).trim();
    if (
      /^(?:the )?company:$/i.test(copy) ||
      (template.id === 'offer-letter' && index > 10 && copy === '{{company-name}}')
    )
      companySection = true;
    if (companySection && !signatoryAdded && /^Name:\s*$/.test(copy)) {
      node.content = [
        ...(node.content ?? []),
        { type: 'text', text: '{{company-signatory-name}}' },
      ];
      template.fields.push({
        id: 'company-signatory-name',
        label: 'Company signatory name',
        marker: '{{company-signatory-name}}',
        original: '____________________',
      });
      signatoryAdded = true;
    }
    if (node.type !== 'paragraph') return [node];
    const title =
      (index === 1 && template.id !== 'offer-letter') ||
      (index === 0 && template.id === 'bylaw-certification');
    if (title) return [heading(node, 1)];
    if (
      /^(Recitals|Agreement|EXHIBIT [A-Z]|Prior Inventions)$/i.test(copy) ||
      (copy.length > 3 && copy.length < 110 && /^[A-Z\s:,()[\]—-]+$/.test(copy))
    )
      return [heading(node, 2)];
    // Numbered clauses and bold subsection labels become a heading followed by their body.
    let sawBold = false;
    let end = 0;
    for (const run of node.content ?? []) {
      const bold = run.marks?.some((mark) => mark.type === 'bold');
      if (
        !bold &&
        run.text?.trim() &&
        !(end === 0 && /^\s*\d+(?:\.\d+)*\.\s*$/.test(run.text)) &&
        !(sawBold && /^[.\s]+$/.test(run.text))
      )
        break;
      sawBold ||= !!bold;
      end++;
    }
    const label = (node.content ?? []).slice(0, end);
    if (
      sawBold &&
      /[a-z]/i.test(text({ content: label })) &&
      text({ content: label }).trim().length < 150 &&
      label.length
    ) {
      const body = (node.content ?? []).slice(end);
      return [
        heading({ ...node, content: label }, 3),
        ...(body.length ? [{ ...node, attrs: undefined, content: body }] : []),
      ];
    }
    return [node];
  });
  return template;
}

export function companyNameForOrganization(name: string): string {
  const names: Record<string, string> = {
    'smol': 'Smol AI Company',
    'smol ai': 'Smol AI Company',
    'ls': 'Swyx Inc',
    'latent space': 'Swyx Inc',
    'aie': 'Software 3.0 Inc',
    'ai engineer': 'Software 3.0 Inc',
  };
  return names[name.trim().toLowerCase()] ?? '';
}

export function templateDefaults(
  template: Pick<DocumentTemplate, 'fields'>,
  company: string,
  userName: string,
) {
  const defaults: Record<string, string> = {};
  for (const field of template.fields) {
    if (field.id === 'company-name' && company) defaults[field.id] = company;
    if (field.id === 'company-signatory-name' && userName) defaults[field.id] = userName;
  }
  return defaults;
}
