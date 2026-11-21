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

type Row = RenameSuggestion & { apply: boolean };

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
      const chosen = rows().filter((row) => row.apply && row.name.trim());
      for (const row of chosen)
        await updateDocument({
          organizationId: props.organizationId,
          documentId: row.documentId,
          name: row.name.trim(),
          notes:
            saveNotes() && row.hasContent && !row.hasNotes && row.description
              ? row.description
              : undefined,
        });
      return chosen.length;
    },
    onSuccess: async (count) => {
      await client.invalidateQueries({ queryKey: ['organizations', props.organizationId] });
      createToast({
        type: 'success',
        message: `Renamed ${count} ${count === 1 ? 'file' : 'files'}`,
      });
      props.onApplied?.();
      props.onOpenChange(false);
    },
  }));

  createEffect(() => {
    if (!props.open) return;
    setRows([]);
    apply.reset();
    suggest.mutate();
  });

  const chosenCount = () => rows().filter((row) => row.apply && row.name.trim()).length;

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
            Suggestions use each file’s name, folder, text, and any available video frames. Select
            the names you want to apply and edit them as needed.
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
          <div class="max-h-[60vh] overflow-y-auto divide-y rounded-md border">
            <Index each={rows()}>
              {(row) => (
                <div class="p-3">
                  <label class="flex w-fit max-w-full cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-muted">
                    <input
                      type="checkbox"
                      class="size-6 shrink-0 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Rename ${row().currentName}`}
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
                    <p class="text-xs text-muted-foreground">
                      {row().description}
                      <Show when={row().hasVisuals}>
                        <span class="ml-1 italic">
                          {row().hasContent
                            ? '(preview frames and transcript)'
                            : '(preview frames and metadata)'}
                        </span>
                      </Show>
                      <Show when={!row().hasContent && !row().hasVisuals}>
                        <span class="ml-1 italic">(filename and folder only)</span>
                      </Show>
                    </p>
                  </div>
                </div>
              )}
            </Index>
          </div>
          <label class="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted">
            <input
              type="checkbox"
              class="size-6 shrink-0 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-ring"
              checked={saveNotes()}
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
            Rename {chosenCount()} {chosenCount() === 1 ? 'file' : 'files'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
