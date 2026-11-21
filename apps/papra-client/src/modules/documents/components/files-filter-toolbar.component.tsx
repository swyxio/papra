import { createSignal, For, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/modules/ui/components/popover';

import type { FileFilter } from './files-filter.models';

const sortFields = [
  ['createdAt', 'Upload date'],
  ['modifiedAt', 'Last modified'],
  ['originalSize', 'Size'],
  ['name', 'File name'],
  ['uploadedBy', 'Uploader'],
  ['modifiedBy', 'Last modifier'],
  ['documentDate', 'Document date'],
  ['updatedAt', 'Last updated (including processing)'],
] as const;

const fieldClass = 'w-full rounded-md border bg-background px-2.5 py-2 text-sm';

export function FileFilterMenu(props: {
  filters: FileFilter[];
  properties: { id: string; name: string }[];
  add: (filter: FileFilter) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [personField, setPersonField] = createSignal('uploadedBy');
  const [personValue, setPersonValue] = createSignal('');
  const [propertyId, setPropertyId] = createSignal('');
  const [propertyValue, setPropertyValue] = createSignal('');
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" flip>
      <PopoverTrigger as={Button} variant="outline" size="sm">
        <span class="i-tabler-filter size-4 mr-1.5" aria-hidden="true" />
        Filters
        <Show when={props.filters.length}>
          <span class="ml-1.5 text-primary">({props.filters.length})</span>
        </Show>
      </PopoverTrigger>
      <PopoverContent class="w-80 max-w-[calc(100vw-2rem)] space-y-3">
        <PopoverTitle class="text-sm font-semibold">Filter files</PopoverTitle>
        <form
          class="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = personValue().trim();
            if (!value) return;
            props.add({ field: personField(), value });
            setPersonValue('');
            setOpen(false);
          }}
        >
          <label class="block space-y-1 text-sm">
            <span>Filter by person</span>
            <select
              class={fieldClass}
              value={personField()}
              onChange={(e) => setPersonField(e.currentTarget.value)}
            >
              <option value="uploadedBy">Uploaded by</option>
              <option value="modifiedBy">Last modified by</option>
            </select>
          </label>
          <label class="block space-y-1 text-sm">
            <span>Name or email</span>
            <input
              class={fieldClass}
              maxLength={256}
              value={personValue()}
              onInput={(e) => setPersonValue(e.currentTarget.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={!personValue().trim()}>
            Apply person filter
          </Button>
        </form>
        <Show when={props.properties.length}>
          <form
            class="border-t pt-3 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!propertyId() || !propertyValue().trim()) return;
              props.add({ field: `property.${propertyId()}`, value: propertyValue() });
              setPropertyValue('');
              setOpen(false);
            }}
          >
            <label class="block space-y-1 text-sm">
              <span>Filter by property</span>
              <select
                class={fieldClass}
                value={propertyId()}
                onChange={(event) => setPropertyId(event.currentTarget.value)}
              >
                <option value="">Choose property</option>
                <For each={props.properties}>
                  {(property) => <option value={property.id}>{property.name}</option>}
                </For>
              </select>
            </label>
            <label class="block space-y-1 text-sm">
              <span>Exact value</span>
              <input
                class={fieldClass}
                maxLength={512}
                value={propertyValue()}
                onInput={(event) => setPropertyValue(event.currentTarget.value)}
              />
            </label>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!propertyId() || !propertyValue().trim()}
            >
              Apply property filter
            </Button>
          </form>
        </Show>
      </PopoverContent>
    </Popover>
  );
}

export function FileSortMenu(props: {
  field: string;
  order: string;
  onSort: (field: string, order: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" flip>
      <PopoverTrigger as={Button} variant="outline" size="sm">
        <span class="i-tabler-arrows-sort size-4 mr-1.5" aria-hidden="true" />
        Sort
      </PopoverTrigger>
      <PopoverContent class="w-80 max-w-[calc(100vw-2rem)]" aria-label="Sort files">
        <label class="block space-y-1 text-sm">
          <span>Sort files</span>
          <select
            class={fieldClass}
            value={`${props.field}:${props.order}`}
            onChange={(e) => {
              const [field, order] = e.currentTarget.value.split(':');
              if (field && order) props.onSort(field, order);
              setOpen(false);
            }}
          >
            <For each={sortFields}>
              {([field, label]) => {
                const alphabetical = ['name', 'uploadedBy', 'modifiedBy'].includes(field);
                return (
                  <>
                    <option value={`${field}:asc`}>
                      {label} ·{' '}
                      {alphabetical
                        ? 'A–Z'
                        : field === 'originalSize'
                          ? 'Smallest first'
                          : 'Oldest first'}
                    </option>
                    <option value={`${field}:desc`}>
                      {label} ·{' '}
                      {alphabetical
                        ? 'Z–A'
                        : field === 'originalSize'
                          ? 'Largest first'
                          : 'Newest first'}
                    </option>
                  </>
                );
              }}
            </For>
          </select>
        </label>
      </PopoverContent>
    </Popover>
  );
}
