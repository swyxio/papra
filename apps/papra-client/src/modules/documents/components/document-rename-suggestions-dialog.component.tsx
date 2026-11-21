import type { Component } from 'solid-js';
import type { RenameProgressEvent, RenameSuggestion } from '../documents-batch.services';
import { createEffect, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
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

type Row = RenameSuggestion & {
  apply: boolean;
  descriptionEdited?: boolean;
  descriptionFeedback?: string;
};

type FileProgress = {
  documentId: string;
  name: string;
  phase: 'queued' | 'reading' | 'drafting' | 'ready' | 'failed';
  startedAt?: number;
  frames?: number;
  hasText?: boolean;
  draftMs?: number;
  message?: string;
};

const durationLabel = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

function fileStatus(file: FileProgress, now: number) {
  if (file.phase === 'queued') return 'Queued';
  if (file.phase === 'reading') return 'Reading cached file details';
  if (file.phase === 'ready') return 'Draft ready';
  if (file.phase === 'failed') return file.message ?? 'Draft unavailable';
  const sources = [
    file.frames ? `${file.frames} ${file.frames === 1 ? 'frame' : 'frames'}` : '',
    file.hasText ? 'available text' : '',
  ].filter(Boolean);
  const elapsed = Math.max(0, Math.floor((now - (file.startedAt ?? now)) / 1000));
  return `Drafting from ${sources.join(' and ')} · ${durationLabel(elapsed)}`;
}

function estimateRemaining(files: FileProgress[], now: number) {
  const remaining = files.filter((file) => file.phase !== 'ready' && file.phase !== 'failed');
  if (!remaining.length) return;
  const estimates: number[] = [];
  for (const file of remaining) {
    if (file.phase !== 'drafting') return;
    const samples = files.flatMap((sample) =>
      sample.phase === 'ready' &&
      sample.frames === file.frames &&
      sample.hasText === file.hasText &&
      sample.draftMs
        ? [sample.draftMs]
        : [],
    );
    if (!samples.length) return;
    const average = samples.reduce((total, ms) => total + ms, 0) / samples.length;
    estimates.push(average - Math.max(0, now - (file.startedAt ?? now)));
  }
  if (estimates.some((ms) => ms <= 0)) return 0;
  return Math.ceil(Math.max(...estimates) / 5000) * 5000;
}

export const DocumentRenameSuggestionsDialog: Component<{
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentIds: string[];
  onApplied?: () => void;
}> = (props) => {
  const client = useQueryClient();
  const [rows, setRows] = createSignal<Row[]>([]);
  const [files, setFiles] = createSignal<FileProgress[]>([]);
  const [startedAt, setStartedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [revisionPhase, setRevisionPhase] = createSignal('Checking file access');
  const [saveNotes, setSaveNotes] = createSignal(true);
  let previewSession = 0;
  let previewController: AbortController | undefined;
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

  const updateFile = (documentId: string, patch: Partial<FileProgress>) =>
    setFiles((current) =>
      current.map((file) => (file.documentId === documentId ? { ...file, ...patch } : file)),
    );

  const receiveProgress = (event: RenameProgressEvent) => {
    if (event.type === 'start') {
      const queued = event.files.map((file): FileProgress => ({ ...file, phase: 'queued' }));
      const byId = new Map(queued.map((file) => [file.documentId, file]));
      setFiles((current) =>
        current.length ? current.map((file) => byId.get(file.documentId) ?? file) : queued,
      );
    } else if (event.type === 'reading') {
      updateFile(event.documentId, { phase: 'reading' });
    } else if (event.type === 'drafting') {
      updateFile(event.documentId, {
        phase: 'drafting',
        startedAt: Date.now(),
        frames: event.frames,
        hasText: event.hasText,
      });
    } else if (event.type === 'failed') {
      updateFile(event.documentId, { phase: 'failed', message: event.message });
    } else if (event.type === 'ready') {
      const result = event.suggestion;
      updateFile(result.documentId, { phase: 'ready', draftMs: event.draftMs });
      setRows((current) => [
        ...current,
        {
          ...result,
          apply:
            result.hasContent &&
            result.name.trim().toLowerCase() !== result.currentName.toLowerCase(),
        },
      ]);
    }
  };

  const suggest = useMutation(() => ({
    mutationFn: async (request: {
      organizationId: string;
      documentIds: string[];
      signal: AbortSignal;
      isRetry?: boolean;
    }) =>
      suggestDocumentNames({
        ...request,
        onProgress: (event) => {
          if (request.signal.aborted) return;
          receiveProgress(event);
          const now = Date.now();
          setNow(now);
          return estimateRemaining(files(), now);
        },
      }),
    onError: (_error, request) => {
      if (request.signal.aborted) return;
      const requested = new Set(request.documentIds);
      setFiles((current) =>
        current.map((file) =>
          !requested.has(file.documentId) || file.phase === 'ready' || file.phase === 'failed'
            ? file
            : {
                ...file,
                phase: 'failed',
                message: 'The connection ended before the draft arrived.',
              },
        ),
      );
    },
  }));

  const reviseDescription = useMutation(() => ({
    mutationFn: async (request: {
      session: number;
      organizationId: string;
      documentId: string;
      feedback: string;
      draft: string;
      signal: AbortSignal;
    }) => {
      let description: string | undefined;
      let failure: string | undefined;
      await suggestDocumentNames({
        organizationId: request.organizationId,
        documentIds: [request.documentId],
        descriptionRevision: { feedback: request.feedback, draft: request.draft },
        signal: request.signal,
        onProgress: (event) => {
          if (request.signal.aborted) return;
          if (event.type === 'reading') setRevisionPhase('Reading cached file details');
          if (event.type === 'drafting') setRevisionPhase('Rewriting description');
          if (event.type === 'ready' && event.suggestion.documentId === request.documentId)
            description = event.suggestion.description.trim();
          if (event.type === 'failed') failure = event.message;
        },
      });
      if (!description)
        throw new Error(
          failure ?? 'No revised description was returned. Try more specific feedback.',
        );
      return description;
    },
    onSuccess: (description, request) => {
      if (props.open && request.session === previewSession)
        update(request.documentId, { description, descriptionEdited: true });
    },
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
    previewSession++;
    const controller = new AbortController();
    previewController = controller;
    onCleanup(() => controller.abort());
    setRows([]);
    setFiles([]);
    setStartedAt(Date.now());
    setNow(Date.now());
    setSaveNotes(true);
    apply.reset();
    reviseDescription.reset();
    suggest.reset();
    suggest.mutate({
      organizationId: untrack(() => props.organizationId),
      documentIds: untrack(() => props.documentIds),
      signal: controller.signal,
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const chosenCount = () => selectedChanges().length;
  const finishedCount = () =>
    files().filter((file) => file.phase === 'ready' || file.phase === 'failed').length;
  const failedCount = () => files().filter((file) => file.phase === 'failed').length;
  const elapsed = () => durationLabel(Math.max(0, Math.floor((now() - startedAt()) / 1000)));
  const estimateLabel = () => {
    const remaining = estimateRemaining(files(), now());
    if (remaining === 0) return 'Taking longer than estimated';
    if (remaining !== undefined) return `About ${durationLabel(remaining / 1000)} left`;
    return files().length > 1
      ? 'Waiting for comparable draft timings'
      : 'Time estimate unavailable';
  };

  const retryIds = () =>
    files().length
      ? files()
          .filter((file) => file.phase === 'failed')
          .map((file) => file.documentId)
      : suggest.error
        ? (suggest.variables?.documentIds ?? [])
        : [];

  const retryFailed = () => {
    if (!previewController || suggest.isPending || reviseDescription.isPending || apply.isPending)
      return;
    const documentIds = retryIds();
    if (!documentIds.length) return;
    const requested = new Set(documentIds);
    const now = Date.now();
    setStartedAt(now);
    setNow(now);
    setFiles((current) =>
      current.map((file) =>
        requested.has(file.documentId)
          ? { documentId: file.documentId, name: file.name, phase: 'queued' }
          : file,
      ),
    );
    suggest.mutate({
      organizationId: props.organizationId,
      documentIds,
      signal: previewController.signal,
      isRetry: true,
    });
  };

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
        <Show when={suggest.isPending || failedCount() > 0}>
          <div class="min-w-0 space-y-2 rounded-md border p-3">
            <div class="flex flex-wrap justify-between gap-x-3 text-sm">
              <p role="status" class="font-medium">
                <Show when={files().length} fallback="Checking file access…">
                  {rows().length}/{files().length} drafts ready
                  <Show when={failedCount()}> · {failedCount()} failed</Show>
                </Show>
              </p>
              <Show when={suggest.isPending}>
                <span class="text-muted-foreground">{elapsed()} elapsed</span>
              </Show>
            </div>
            <Show when={files().length}>
              <progress
                aria-label="Files processed"
                class="h-2 w-full accent-primary"
                value={finishedCount()}
                max={files().length}
              />
              <Show when={suggest.isPending}>
                <p class="text-xs text-muted-foreground">{estimateLabel()}</p>
              </Show>
              <ul class="max-h-28 overflow-y-auto space-y-1 text-xs">
                <For each={files()}>
                  {(file) => (
                    <li class="flex flex-wrap justify-between gap-x-3">
                      <span class="min-w-0 truncate" title={file.name}>
                        {file.name}
                      </span>
                      <span
                        class={file.phase === 'failed' ? 'text-red-400' : 'text-muted-foreground'}
                      >
                        {fileStatus(file, now())}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
        <Show when={!suggest.variables?.signal.aborted && suggest.error}>
          {(err) => <p class="text-sm text-red-500">{getHttpErrorMessage(err())}</p>}
        </Show>
        <Show when={rows().length > 0}>
          <fieldset
            disabled={apply.isPending}
            class="min-w-0 max-h-[58vh] overflow-y-auto divide-y rounded-md border"
          >
            <For each={files().map((file) => file.documentId)}>
              {(documentId) => (
                <Show when={rows().find((row) => row.documentId === documentId)}>
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
                            update(row().documentId, {
                              name: event.currentTarget.value,
                              apply: true,
                            })
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
                              disabled={
                                !saveNotes() ||
                                (reviseDescription.isPending &&
                                  reviseDescription.variables?.documentId === row().documentId)
                              }
                              onInput={(event) => {
                                update(row().documentId, {
                                  description: event.currentTarget.value,
                                  descriptionEdited: true,
                                  apply: true,
                                });
                              }}
                            />
                          </label>
                          <Show when={saveNotes() && (row().hasVisuals || row().hasContent)}>
                            <details class="text-sm">
                              <summary class="w-fit cursor-pointer rounded px-1 py-1.5 text-muted-foreground hover:bg-muted">
                                Revise description
                              </summary>
                              <div class="space-y-2 rounded-md border p-2">
                                <label class="block space-y-1">
                                  <span class="text-xs text-muted-foreground">
                                    What should change?
                                  </span>
                                  <textarea
                                    aria-label={`Description feedback for ${row().currentName}`}
                                    class="w-full resize-y rounded-md border bg-background px-2 py-1 text-sm"
                                    rows={2}
                                    placeholder="e.g. Focus on the camera angle and framing"
                                    maxLength={600}
                                    value={row().descriptionFeedback ?? ''}
                                    onInput={(event) =>
                                      update(row().documentId, {
                                        descriptionFeedback: event.currentTarget.value,
                                      })
                                    }
                                  />
                                </label>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  isLoading={
                                    reviseDescription.isPending &&
                                    reviseDescription.variables?.documentId === row().documentId
                                  }
                                  disabled={
                                    reviseDescription.isPending ||
                                    !row().descriptionFeedback?.trim()
                                  }
                                  onClick={() => {
                                    if (!previewController) return;
                                    setRevisionPhase('Checking file access');
                                    reviseDescription.mutate({
                                      session: previewSession,
                                      organizationId: props.organizationId,
                                      documentId: row().documentId,
                                      feedback: row().descriptionFeedback?.trim() ?? '',
                                      draft: row().description.slice(0, 3000),
                                      signal: previewController.signal,
                                    });
                                  }}
                                >
                                  Regenerate description
                                </Button>
                                <Show
                                  when={
                                    reviseDescription.isPending &&
                                    reviseDescription.variables?.documentId === row().documentId
                                  }
                                >
                                  <p role="status" class="text-xs text-muted-foreground">
                                    {revisionPhase()}…
                                  </p>
                                </Show>
                                <Show
                                  when={
                                    reviseDescription.variables?.documentId === row().documentId &&
                                    reviseDescription.error
                                  }
                                >
                                  {(err) => (
                                    <p role="alert" class="text-xs text-red-500">
                                      {getHttpErrorMessage(err())}
                                    </p>
                                  )}
                                </Show>
                              </div>
                            </details>
                          </Show>
                        </Show>
                      </div>
                    </div>
                  )}
                </Show>
              )}
            </For>
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
          <Show when={!suggest.isPending && retryIds().length}>
            <Button
              variant="outline"
              onClick={retryFailed}
              disabled={apply.isPending || reviseDescription.isPending}
            >
              {files().length ? 'Retry failed files' : 'Retry suggestions'}
            </Button>
          </Show>
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
            disabled={suggest.isPending || reviseDescription.isPending || chosenCount() === 0}
          >
            Apply to {chosenCount()} {chosenCount() === 1 ? 'file' : 'files'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
