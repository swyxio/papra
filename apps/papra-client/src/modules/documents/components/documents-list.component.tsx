import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/solid-table';
import type { Accessor, Component, Setter } from 'solid-js';
import type { Document } from '../documents.types';
import type { Pagination } from '@/modules/shared/pagination/pagination.types';
import type { Tag } from '@/modules/tags/tags.types';
import { formatBytes } from '@corentinth/chisels';
import { A } from '@solidjs/router';
import {
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
} from '@tanstack/solid-table';
import { For, Match, Show, Switch } from 'solid-js';
import { RelativeTime } from '@/modules/i18n/components/RelativeTime';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { cn } from '@/modules/shared/style/cn';
import { DocumentTagsList } from '@/modules/tags/components/tag-list.component';
import { Button } from '@/modules/ui/components/button';
import { Checkbox, CheckboxControl } from '@/modules/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/modules/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/modules/ui/components/table';
import {
  getDocumentIcon,
  getDocumentNameExtension,
  getDocumentNameWithoutExtension,
} from '../document.models';
import { selectRange } from '@/modules/drive-collaboration/drive-folders.models';
import { useQuery } from '@tanstack/solid-query';
import {
  folderTreeQuery,
  folderPath,
} from '@/modules/drive-collaboration/drive-collaboration.services';
import { DocumentManagementDropdown } from './document-management-dropdown.component';

// Last checkbox clicked per table, the start of a shift-click range.
const selectionAnchors = new WeakMap<object, string>();

// On desktop, row controls stay hidden until the row is hovered or focused, so idle rows stay clean.
const revealOnHover = 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100';
const revealUntilSelected = (table: {
  getIsSomeRowsSelected: () => boolean;
  getIsAllRowsSelected: () => boolean;
}) => (table.getIsSomeRowsSelected() || table.getIsAllRowsSelected() ? undefined : revealOnHover);

const selectionColumn: ColumnDef<Document> = {
  id: 'select',
  header: (props) => {
    const { t } = useI18n();

    return (
      <Checkbox
        checked={props.table.getIsAllPageRowsSelected()}
        indeterminate={
          props.table.getIsSomePageRowsSelected() && !props.table.getIsAllPageRowsSelected()
        }
        onChange={(value) => props.table.toggleAllPageRowsSelected(value)}
        aria-label={t('documents.list.select.all')}
        class={revealUntilSelected(props.table)}
      >
        <CheckboxControl />
      </Checkbox>
    );
  },
  cell: (props) => {
    const { t } = useI18n();
    let shiftKey = false;

    return (
      <Checkbox
        checked={props.row.getIsSelected()}
        onPointerDown={(event: PointerEvent) => (shiftKey = event.shiftKey)}
        onMouseDown={(event: MouseEvent) => event.shiftKey && event.preventDefault()}
        onKeyDown={(event: KeyboardEvent) => (shiftKey = event.shiftKey)}
        onChange={(value) => {
          const anchorId = selectionAnchors.get(props.table);
          selectionAnchors.set(props.table, props.row.id);
          if (!shiftKey || anchorId === undefined) {
            props.row.toggleSelected(value);
            return;
          }
          const ids = props.table.getRowModel().rows.map((row) => row.id);
          props.table.setRowSelection((selection) =>
            selectRange({ ids, anchorId, targetId: props.row.id, selected: value, selection }),
          );
        }}
        aria-label={t('documents.list.select.row')}
        title="Shift-click to select a range"
        class={revealUntilSelected(props.table)}
      >
        <CheckboxControl />
      </Checkbox>
    );
  },
  enableSorting: false,
  enableHiding: false,
};

export const documentDateColumn: ColumnDef<Document> = {
  header: () => {
    const { t } = useI18n();
    return (
      <span class="sr-only sm:not-sr-only">{t('documents.list.table.headers.document-date')}</span>
    );
  },
  accessorKey: 'documentDate',
  enableSorting: true,
  cell: (data) => {
    const { t } = useI18n();
    const value = data.getValue<Date | null | undefined>();
    return (
      <span class="text-muted-foreground hidden sm:block">
        <Show when={value} fallback={<span class="sr-only">{t('documents.info.no-date')}</span>}>
          {(date) => <RelativeTime date={date()} />}
        </Show>
      </span>
    );
  },
};

export const locationColumn: ColumnDef<Document> = {
  id: 'location',
  header: () => <span class="sr-only sm:not-sr-only">Location</span>,
  enableSorting: false,
  cell: (data) => {
    const organizationId = data.row.original.organizationId;
    const folders = useQuery(() => ({
      ...folderTreeQuery(organizationId),
    }));
    const folder = () =>
      folders.data?.folders.find((item) => item.id === data.row.original.homeFolderId);
    return (
      <Show when={folder()}>
        {(current) => (
          <A
            href={`/organizations/${organizationId}/documents?folder=${current().id}`}
            class="hidden sm:flex items-center gap-1.5 max-w-56 text-sm text-muted-foreground hover:text-foreground"
            title={folderPath(current(), folders.data?.folders ?? [])}
          >
            <div class="i-tabler-folder size-4 shrink-0" />
            <span class="truncate">
              {folderPath(current(), folders.data?.folders ?? []).replace(/^Home \/ /, '')}
            </span>
          </A>
        )}
      </Show>
    );
  },
};

export const createdAtColumn: ColumnDef<Document> = {
  header: () => {
    const { t } = useI18n();
    return <span class="sr-only sm:not-sr-only">{t('documents.list.table.headers.created')}</span>;
  },
  accessorKey: 'createdAt',
  enableSorting: true,
  cell: (data) => (
    <RelativeTime class="text-muted-foreground hidden sm:block" date={data.getValue<Date>()} />
  ),
};

export const uploadedByColumn: ColumnDef<Document> = {
  header: () => <span class="sr-only sm:not-sr-only">Uploaded by</span>,
  id: 'uploadedBy',
  accessorFn: (row) => row.uploadedBy?.name || row.uploadedBy?.email || '',
  enableSorting: true,
  cell: (data) => {
    const person = data.row.original.uploadedBy;
    return (
      <span class="hidden sm:block text-sm" title={person?.email}>
        {person?.name || person?.email || 'Unknown'}
      </span>
    );
  },
};

export const modifiedByColumn: ColumnDef<Document> = {
  header: () => <span class="sr-only sm:not-sr-only">Modified by</span>,
  id: 'modifiedBy',
  accessorFn: (row) => row.modifiedBy?.name || row.modifiedBy?.email || '',
  enableSorting: true,
  cell: (data) => {
    const person = data.row.original.modifiedBy;
    return (
      <span class="hidden sm:block text-sm" title={person?.email}>
        {person?.name || person?.email || 'Unknown'}
      </span>
    );
  },
};

export const modifiedAtColumn: ColumnDef<Document> = {
  header: () => <span class="sr-only sm:not-sr-only">Last modified</span>,
  accessorKey: 'modifiedAt',
  enableSorting: true,
  cell: (data) => (
    <Show
      when={data.row.original.modifiedAt}
      fallback={<span class="hidden sm:block text-muted-foreground">Unknown</span>}
    >
      {(date) => (
        <RelativeTime class="hidden sm:block text-muted-foreground text-sm" date={date()} />
      )}
    </Show>
  ),
};

export const sizeColumn: ColumnDef<Document> = {
  header: () => <span class="sr-only sm:not-sr-only">Size</span>,
  accessorKey: 'originalSize',
  enableSorting: true,
  cell: (data) => (
    <span class="hidden sm:block whitespace-nowrap text-sm text-muted-foreground">
      {formatBytes({ bytes: data.getValue<number>() ?? 0 })}
    </span>
  ),
};

export const deletedAtColumn: ColumnDef<Document> = {
  header: () => {
    const { t } = useI18n();
    return <span class="sr-only sm:not-sr-only">{t('documents.list.table.headers.deleted')}</span>;
  },
  accessorKey: 'deletedAt',
  cell: (data) => (
    <RelativeTime class="text-muted-foreground hidden sm:block" date={data.getValue<Date>()} />
  ),
};

export const standardActionsColumn: ColumnDef<Document> = {
  header: () => {
    const { t } = useI18n();
    return <span class="sr-only">{t('documents.list.table.headers.actions')}</span>;
  },
  id: 'actions',
  enableSorting: false,
  cell: (data) => (
    <div class={cn('flex items-center justify-end', revealOnHover)}>
      <DocumentManagementDropdown document={data.row.original} />
    </div>
  ),
};

export const tagsColumn: ColumnDef<Document> = {
  header: () => {
    const { t } = useI18n();
    return <span class="sr-only sm:not-sr-only">{t('documents.list.table.headers.tags')}</span>;
  },
  accessorKey: 'tags',
  enableSorting: false,
  cell: (data) => (
    <DocumentTagsList
      tags={data.getValue<Tag[]>()}
      tagClass="text-xs text-muted-foreground"
      triggerClass={cn(
        'size-6',
        data.getValue<Tag[]>().length === 0 && revealOnHover,
        'focus-visible:opacity-100',
      )}
      documentId={data.row.original.id}
      organizationId={data.row.original.organizationId}
      asLink
    />
  ),
};

export const DocumentsPaginatedList: Component<{
  documents: Document[];
  documentsCount: number;
  getPagination?: Accessor<Pagination>;
  setPagination?: Setter<Pagination>;
  extraColumns?: ColumnDef<Document>[];
  showPagination?: boolean;
  enableBatchSelection?: boolean;
  getRowSelection?: Accessor<RowSelectionState>;
  setRowSelection?: Setter<RowSelectionState>;
  getSorting?: Accessor<SortingState>;
  setSorting?: Setter<SortingState>;
}> = (props) => {
  const { t } = useI18n();
  const table = createSolidTable({
    get data() {
      return props.documents ?? [];
    },
    getRowId: (row) => row.id,
    columns: [
      ...(props.enableBatchSelection ? [selectionColumn] : []),
      {
        header: () => t('documents.list.table.headers.file-name'),
        id: 'name',
        accessorFn: (row) => row.name,
        enableSorting: true,
        cell: (data) => (
          <div class="overflow-hidden min-w-0 flex gap-2 sm:gap-4 items-center max-w-500px">
            <div class="bg-muted shrink-0 flex items-center justify-center p-2 rounded-lg">
              <div
                class={cn(getDocumentIcon({ document: data.row.original }), 'size-6 text-primary')}
              />
            </div>

            <div class="min-w-0 flex-1 flex flex-col gap-1 truncate">
              <A
                href={`/organizations/${data.row.original.organizationId}/documents/${data.row.original.id}`}
                class="font-bold truncate block hover:underline"
                title={data.row.original.name}
              >
                {getDocumentNameWithoutExtension({
                  name: data.row.original.name,
                })}
              </A>

              <div class="text-xs text-muted-foreground lh-tight">
                {[
                  formatBytes({ bytes: data.row.original.originalSize, base: 1000 }),
                  getDocumentNameExtension({ name: data.row.original.name }),
                ]
                  .filter(Boolean)
                  .join(' - ')}{' '}
                - <RelativeTime date={data.row.original.createdAt} />
                <Show when={data.row.original.isShortcut}>
                  <span class="ml-2 inline-flex items-center gap-1">
                    <span class="i-tabler-arrow-up-right size-3" />
                    Shortcut
                  </span>
                </Show>
              </div>
              <div class="sm:hidden text-sm text-muted-foreground whitespace-normal">
                Uploaded by{' '}
                {data.row.original.uploadedBy?.name ||
                  data.row.original.uploadedBy?.email ||
                  'Unknown'}
                <Show when={data.row.original.modifiedBy}>
                  {(person) => <> · Modified by {person().name || person().email}</>}
                </Show>
              </div>
            </div>
          </div>
        ),
      },
      ...(props.extraColumns ?? []),
    ],
    get rowCount() {
      return props.documentsCount;
    },
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: props.setPagination,
    onRowSelectionChange: props.setRowSelection,
    onSortingChange: props.setSorting,
    enableRowSelection: props.enableBatchSelection ?? false,
    enableSorting: Boolean(props.setSorting),
    state: {
      get pagination() {
        return props.getPagination?.();
      },
      get rowSelection() {
        return props.getRowSelection?.() ?? {};
      },
      get sorting() {
        return props.getSorting?.() ?? [];
      },
    },
    manualPagination: true,
    manualSorting: true,
  });

  return (
    <div>
      <Switch>
        <Match when={props.documentsCount > 0}>
          <Table class="table-fixed sm:table-auto">
            <TableHeader>
              <For each={table.getHeaderGroups()}>
                {(headerGroup) => (
                  <TableRow class="group">
                    <For each={headerGroup.headers}>
                      {(header) => {
                        return (
                          <TableHead
                            class={cn(
                              !['select', 'name', 'actions'].includes(header.column.id) &&
                                'hidden sm:table-cell',
                              ['select', 'actions'].includes(header.column.id) && 'w-10 sm:w-auto',
                            )}
                          >
                            <Show when={!header.isPlaceholder}>
                              <Show
                                when={header.column.getCanSort()}
                                fallback={flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                              >
                                <button
                                  type="button"
                                  class="flex items-center gap-1 cursor-pointer select-none"
                                  onClick={header.column.getToggleSortingHandler()}
                                >
                                  {flexRender(header.column.columnDef.header, header.getContext())}
                                  <Show when={header.column.getIsSorted() === 'asc'}>
                                    <div class="i-tabler-arrow-up size-3.5" />
                                  </Show>
                                  <Show when={header.column.getIsSorted() === 'desc'}>
                                    <div class="i-tabler-arrow-down size-3.5" />
                                  </Show>
                                  <Show when={!header.column.getIsSorted()}>
                                    <div class="i-tabler-arrows-sort size-3.5 opacity-40" />
                                  </Show>
                                </button>
                              </Show>
                            </Show>
                          </TableHead>
                        );
                      }}
                    </For>
                  </TableRow>
                )}
              </For>
            </TableHeader>

            <TableBody>
              <Show when={table.getRowModel().rows?.length}>
                <For each={table.getRowModel().rows}>
                  {(row) => (
                    <TableRow class="group" data-state={row.getIsSelected() && 'selected'}>
                      <For each={row.getVisibleCells()}>
                        {(cell) => (
                          <TableCell
                            class={cn(
                              !['select', 'name', 'actions'].includes(cell.column.id) &&
                                'hidden sm:table-cell',
                              ['select', 'actions'].includes(cell.column.id) && 'w-10 sm:w-auto',
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        )}
                      </For>
                    </TableRow>
                  )}
                </For>
              </Show>
            </TableBody>
          </Table>

          <Show when={props.showPagination ?? true}>
            <div class="flex flex-col-reverse items-center gap-4 sm:flex-row sm:justify-end mt-4">
              <div class="flex items-center space-x-2">
                <p class="whitespace-nowrap text-sm font-medium">
                  {t('common.tables.rows-per-page')}
                </p>
                <Select
                  value={table.getState().pagination.pageSize}
                  onChange={(value) => value && table.setPageSize(value)}
                  options={[15, 50, 100]}
                  itemComponent={(props) => (
                    <SelectItem item={props.item}>{props.item.rawValue}</SelectItem>
                  )}
                >
                  <SelectTrigger class="h-8 w-[4.5rem]">
                    <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </div>
              <div class="flex items-center justify-center whitespace-nowrap text-sm font-medium">
                {t('common.tables.pagination-info', {
                  currentPage: table.getState().pagination.pageIndex + 1,
                  totalPages: table.getPageCount(),
                })}
              </div>
              <div class="flex items-center space-x-2">
                <Button
                  aria-label={t('common.tables.first-page')}
                  variant="outline"
                  class="flex size-8 p-0"
                  onClick={() => table.setPageIndex(0)}
                  disabled={!table.getCanPreviousPage()}
                >
                  <div class="size-4 i-tabler-chevrons-left" />
                </Button>
                <Button
                  aria-label={t('common.tables.previous-page')}
                  variant="outline"
                  size="icon"
                  class="size-8"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  <div class="size-4 i-tabler-chevron-left" />
                </Button>
                <Button
                  aria-label={t('common.tables.next-page')}
                  variant="outline"
                  size="icon"
                  class="size-8"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  <div class="size-4 i-tabler-chevron-right" />
                </Button>
                <Button
                  aria-label={t('common.tables.last-page')}
                  variant="outline"
                  size="icon"
                  class="flex size-8"
                  onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                  disabled={!table.getCanNextPage()}
                >
                  <div class="size-4 i-tabler-chevrons-right" />
                </Button>
              </div>
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  );
};
