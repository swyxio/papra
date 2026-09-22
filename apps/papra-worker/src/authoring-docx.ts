import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { IParagraphOptions, INumberingOptions } from 'docx';
import type { DocumentNode } from './authoring-pdf';

export const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export async function renderDocx(source: DocumentNode, title: string) {
  const numbering: INumberingOptions['config'][number][] = [];
  function runs(nodes: DocumentNode[] = []): TextRun[] {
    return nodes.flatMap((n) =>
      n.type === 'hardBreak'
        ? [new TextRun({ break: 1 })]
        : n.type === 'text'
          ? n
              .text!.split('\n')
              .flatMap((line, i) => [
                new TextRun({
                  text: line,
                  ...(i ? { break: 1 } : {}),
                  ...(n.marks?.some((m) => m.type === 'bold') ? { bold: true } : {}),
                  ...(n.marks?.some((m) => m.type === 'italic') ? { italics: true } : {}),
                  ...(n.marks?.some((m) => m.type === 'strike') ? { strike: true } : {}),
                  ...(n.marks?.some((m) => m.type === 'underline') ? { underline: {} } : {}),
                  ...(n.marks?.some((m) => m.type === 'code') ? { font: 'Courier New' } : {}),
                }),
              ])
          : [],
    );
  }
  function blocks(
    node: DocumentNode,
    depth = 0,
    paragraph: IParagraphOptions = {},
  ): (Paragraph | Table)[] {
    if (node.type === 'paragraph' || node.type === 'heading')
      return [
        new Paragraph({
          ...paragraph,
          children: runs(node.content),
          ...(node.type === 'heading'
            ? {
                heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
                  node.attrs!.level - 1
                ],
              }
            : {}),
          ...(node.attrs?.pageBreakBefore ? { pageBreakBefore: true } : {}),
        }),
      ];
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      const reference = `list-${numbering.length}`;
      numbering.push({
        reference,
        levels: [
          {
            level: 0,
            format: node.type === 'bulletList' ? LevelFormat.BULLET : LevelFormat.DECIMAL,
            text: node.type === 'bulletList' ? '•' : '%1.',
            start: node.attrs?.start || 1,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (depth + 1), hanging: 360 } } },
          },
        ],
      });
      return (node.content || []).flatMap((item) => {
        let numbered = false;
        return (item.content || []).flatMap((child) => {
          if (child.type === 'paragraph' || child.type === 'heading') {
            const options = numbered
              ? { indent: { left: 720 * (depth + 1) } }
              : { numbering: { reference, level: 0 } };
            numbered = true;
            return blocks(child, depth + 1, options);
          }
          return blocks(child, depth + 1);
        });
      });
    }
    if (node.type === 'blockquote')
      return (node.content || []).flatMap((child) =>
        blocks(child, depth, { indent: { left: 320 } }),
      );
    if (node.type === 'horizontalRule')
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1' } },
        }),
      ];
    if (node.type === 'table')
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: node.content!.map(
            (row) =>
              new TableRow({
                tableHeader: row.content!.every((c) => c.type === 'tableHeader'),
                children: row.content!.map(
                  (cell) =>
                    new TableCell({
                      children: cell.content!.flatMap((child) =>
                        blocks(child, 0, {
                          spacing: { after: 70 },
                          ...(cell.type === 'tableHeader' ? { style: 'TableHeader' } : {}),
                        }),
                      ),
                      ...(cell.type === 'tableHeader' ? { shading: { fill: 'F1F5F9' } } : {}),
                      margins: { top: 100, bottom: 100, left: 100, right: 100 },
                    }),
                ),
              }),
          ),
        }),
      ];
    if (node.type === 'doc' || node.type === 'listItem')
      return (node.content || []).flatMap((child) => blocks(child, depth, paragraph));
    throw new Error('Unsupported Word document content');
  }
  const children = blocks(source);
  const document = new Document({
    title,
    creator: 'SwyxDrive',
    numbering: { config: numbering },
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '263244' },
          paragraph: { spacing: { after: 240, line: 324 } },
        },
      },
      paragraphStyles: [
        { id: 'TableHeader', name: 'Table header', basedOn: 'Normal', run: { bold: true } },
        ...[
          ['Heading1', 48, 80, 360],
          ['Heading2', 30, 360, 120],
          ['Heading3', 24, 360, 120],
        ].map(([id, size, before, after]) => ({
          id: String(id),
          name: String(id),
          basedOn: 'Normal',
          next: 'Normal',
          run: { font: 'Arial', size: Number(size), bold: true, color: '111827' },
          paragraph: { keepNext: true, spacing: { before: Number(before), after: Number(after) } },
        })),
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 960, bottom: 960, left: 960, right: 960 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES],
                    size: 16,
                    color: '64748B',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}
