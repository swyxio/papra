import type { Component } from 'solid-js';
import type { RenameSuggestion } from '../documents-batch.services';
import { createEffect, createSignal, Index, Show } from 'solid-js';
import { useMutation, useQueryClient } from '@tanstack/solid-query';
import { getHttpErrorMessage } from '@/modules/shared/http/http-errors';
import { Button } from '@/modules/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/modules/ui/components/dialog';
import { createToast } from '@/modules/ui/components/sonner';
import { suggestDocumentNames } from '../documents-batch.services';
import { updateDocument } from '../documents.services';

export const MAX_RENAME_SUGGESTIONS = 20;

type Row = RenameSuggestion & { apply: boolean; descriptionEdited?: boolean };

export const DocumentRenameSuggestionsDialog: Component<{
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentIds: string[];
  onApplied?: () => void;
}> = (props) => {
  const client = useQueryClient();
  const [rows, setRows] = createSignal<Row[]>([]);
  const [saveNotes, setSaveNotes] = createSignal(true);
  const update = (id: string, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.documentId === id ? { ...row, ...patch } : row)),
    );

  const selectedChanges = () =>
    rows().flatMap((row) => {
      const name = row.name.trim();
      if (!row.apply || !name) return [];
      const newName = name !== row.currentName ? name : undefined;
      const notesIfEmpty =
        saveNotes() && !row.hasNotes && (row.hasContent || row.hasVisuals || row.descriptionEdited)
          ? row.description.trim() || undefined
          : undefined;
      return newName || notesIfEmpty
        ? [{ documentId: row.documentId, name: newName, notesIfEmpty }]
        : [];
    });

  const suggest = useMutation(() => ({
    mutationFn: async () =>
      suggestDocumentNames({
        organizationId: props.organizationId,
        documentIds: props.documentIds,
      }),
    onSuccess: ({ suggestions }) =>
      setRows(
        suggestions.map((s) => ({
          ...s,
          apply: s.hasContent && s.name.trim().toLowerCase() !== s.currentName.toLowerCase(),
        })),
      ),
  }));

  const apply = useMutation(() => ({
    mutationFn: async () => {
      const chosen = selectedChanges();
      for (const change of chosen) {
        const { document } = await updateDocument({
          ...change,
          organizationId: props.organizationId,
        });
        update(change.documentId, {
          apply: false,
          currentName: document.name,
          hasNotes: Boolean(document.notes?.trim()),
        });
      }
      return chosen.length;
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
    },
    onSuccess: (count) => {
      createToast({
        type: 'success',
        message: `Updated ${count} ${count === 1 ? 'file' : 'files'}`,
      });
      props.onApplied?.();
      props.onOpenChange(false);
    },
  }));

  createEffect(() => {
    if (!props.open) return;
    setRows([]);
    setSaveNotes(true);
    apply.reset();
    suggest.mutate();
  });

  const chosenCount = () => selectedChanges().length;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!apply.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent class="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Suggested names</DialogTitle>
          <DialogDescription>
            Review and edit each name and description. You can keep a file’s original name and save
            just its description as a note.
          </DialogDescription>
        </DialogHeader>
        <Show when={suggest.isPending}>
          <p role="status" class="text-sm text-muted-foreground flex items-center gap-2">
            <span class="i-tabler-loader-2 size-4 animate-spin" />
            Reading {props.documentIds.length} {props.documentIds.length === 1 ? 'file' : 'files'}…
          </p>
        </Show>
        <Show when={suggest.error}>
          {(err) => <p class="text-sm text-red-500">{getHttpErrorMessage(err())}</p>}
        </Show>
        <Show when={suggest.isSuccess && rows().length < props.documentIds.length}>
          <p class="text-xs text-muted-foreground">
            No suggestion for {props.documentIds.length - rows().length} of the selected files. Try
            them again later.
          </p>
        </Show>
        <Show when={rows().length > 0}>
          <fieldset
            disabled={apply.isPending}
            class="min-w-0 max-h-[58vh] overflow-y-auto divide-y rounded-md border"
          >
            <Index each={rows()}>
              {(row) => (
                <div class="p-3">
                  <label class="flex w-fit max-w-full cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-muted">
                    <input
                      type="checkbox"
                      class="size-6 shrink-0 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Select changes for ${row().currentName}`}
                      checked={row().apply}
                      onChange={(event) =>
                        update(row().documentId, { apply: event.currentTarget.checked })
                      }
                    />
                    <span class="truncate text-sm font-medium" title={row().currentName}>
                      {row().currentName}
                    </span>
                  </label>
                  <div class="min-w-0 space-y-1 pl-9">
                    <input
                      aria-label={`New name for ${row().currentName}`}
                      class="w-full rounded-md border bg-background px-2 py-1 text-sm font-medium"
                      value={row().name}
                      maxLength={512}
                      onInput={(event) =>
                        update(row().documentId, { name: event.currentTarget.value, apply: true })
                      }
                    />
                    <div class="flex flex-wrap items-center justify-between gap-x-2">
                      <span class="text-xs text-muted-foreground">
                        {row().hasVisuals
                          ? row().hasContent
                            ? 'Preview frames and available text'
                            : 'Preview frames and filename'
                          : row().hasContent
                            ? 'Available text and filename'
                            : 'Filename and folder only'}
                      </span>
                      <Show when={row().name !== row().currentName}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          class="h-auto px-2 py-1 text-xs"
                          onClick={() => update(row().documentId, { name: row().currentName })}
                        >
                          Keep original name
                        </Button>
                      </Show>
                    </div>
                    <Show
                      when={!row().hasNotes}
                      fallback={
                        <p class="text-xs text-muted-foreground">Existing note will be kept.</p>
                      }
                    >
                      <label class="block space-y-1">
                        <span class="text-xs text-muted-foreground">Description</span>
                        <textarea
                          aria-label={`Description for ${row().currentName}`}
                          class="w-full resize-y rounded-md border bg-background px-2 py-1 text-sm"
                          rows={2}
                          placeholder="Add a note about this file"
                          value={row().description}
                          disabled={!saveNotes()}
                          onInput={(event) => {
                            update(row().documentId, {
                              description: event.currentTarget.value,
                              descriptionEdited: true,
                              apply: true,
                            });
                          }}
                        />
                      </label>
                    </Show>
                  </div>
                </div>
              )}
            </Index>
          </fieldset>
          <label class="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted">
            <input
              type="checkbox"
              class="size-6 shrink-0 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-ring"
              checked={saveNotes()}
              disabled={apply.isPending}
              onChange={(event) => setSaveNotes(event.currentTarget.checked)}
            />
            Save descriptions as notes on files that have none
          </label>
        </Show>
        <Show when={apply.error}>
          {(err) => <p class="text-sm text-red-500">{getHttpErrorMessage(err())}</p>}
        </Show>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={apply.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => apply.mutate()}
            isLoading={apply.isPending}
            disabled={suggest.isPending || chosenCount() === 0}
          >
            Apply to {chosenCount()} {chosenCount() === 1 ? 'file' : 'files'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
