import type { Component } from 'solid-js';
import { createSignal, Show } from 'solid-js';
import { isFileDrag, readDroppedFiles } from '@/modules/shared/files/drop';
import { cn } from '@/modules/shared/style/cn';
import { Button } from '@/modules/ui/components/button';
import { useDocumentUpload } from './document-import-status.component';

export const DocumentUploadArea: Component = () => {
  const [isDragging, setIsDragging] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [reading, setReading] = createSignal(false);

  const { promptImport, promptFolderImport, uploadDocuments } = useDocumentUpload();

  const handleDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    setIsDragging(false);
  };

  const handleDrop = async (event: DragEvent) => {
    if (!isFileDrag(event) || !event.dataTransfer) return;
    event.preventDefault();
    setIsDragging(false);
    setError(undefined);
    setReading(true);
    const dropped = readDroppedFiles(event.dataTransfer);
    try {
      const files = await dropped;
      setReading(false);
      await uploadDocuments(files);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not read these files. Try Upload a folder.',
      );
    } finally {
      setReading(false);
    }
  };

  return (
    <div
      class={cn(
        'border border-[2px] border-dashed text-muted-foreground rounded-lg p-6 sm:py-16 flex flex-col items-center justify-center text-center',
        { 'border-primary': isDragging() },
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div class="i-tabler-cloud-upload size-12 mb-4" />
      <p>
        {reading()
          ? 'Reading folder contents…'
          : isDragging()
            ? 'Drop files or folders to upload'
            : 'Drag and drop files or folders here to upload'}
      </p>
      <Show when={error()}>
        <div role="alert" class="mt-3 text-sm text-red-600 dark:text-red-300">
          {error()}{' '}
          <button type="button" class="underline ml-2" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      </Show>

      <Button class="mt-4" variant="outline" onClick={promptImport}>
        <div class="i-tabler-upload mr-2" />
        Select files
      </Button>
      <Button class="mt-2" variant="ghost" onClick={promptFolderImport}>
        Upload a folder
      </Button>
    </div>
  );
};
