import type { JSONContent } from '@tiptap/core';

export type TemplateSummary = {
  id: string;
  name: string;
  url: string;
  preparedAt: string;
  originalSha256: string;
};
export type TemplateField = {
  id: string;
  label: string;
  marker: string;
  original: string;
  section?: string;
  multiline?: boolean;
  inputType?: 'date' | 'password';
  options?: { value: string; label: string }[];
};
export type FillableTemplate = { source: JSONContent; fields: TemplateField[] };
export type DocumentTemplate = TemplateSummary & FillableTemplate & { guidance: string };

// Replace only original template markers. Values containing braces cannot replace other fields.
export function fillTemplate(
  template: FillableTemplate,
  values: Record<string, string>,
): JSONContent {
  const replacements = new Map(
    template.fields.map((field) => [field.marker, values[field.id]?.trim() || field.original]),
  );
  function fill(node: JSONContent): JSONContent {
    return {
      ...node,
      ...(node.text
        ? {
            text: node.text.replace(
              /\{\{[a-z0-9-]+\}\}/g,
              (marker) => replacements.get(marker) ?? marker,
            ),
          }
        : {}),
      ...(node.content ? { content: node.content.map(fill) } : {}),
    };
  }
  return fill(template.source);
}
