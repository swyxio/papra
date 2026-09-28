import type { Component } from 'solid-js';
import { createSignal, onCleanup, Show } from 'solid-js';
import { cn } from '@/modules/shared/style/cn';
import { isFileDrag, readDroppedFiles } from '@/modules/shared/files/drop';

export const GlobalDropArea: Component<{
  onFilesDrop?: (args: { files: File[]; folderImport?: boolean }) => void | Promise<void>;
}> = (props) => {
  const [isDragging, setIsDragging] = createSignal(false);
  const [isReading, setIsReading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let depth = 0;
  const reset = () => {
    depth = 0;
    setIsDragging(false);
  };
  const handleDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth++;
    setIsDragging(true);
  };
  const handleDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setIsDragging(false);
  };
  const handleDrop = async (event: DragEvent) => {
    reset();
    if (event.defaultPrevented || !isFileDrag(event) || !event.dataTransfer) return;
    event.preventDefault();
    setError(undefined);
    setIsReading(true);
    // Start reading while the drop's DataTransfer is still accessible.
    const reading = readDroppedFiles(event.dataTransfer);
    try {
      const dropped = await reading;
      setIsReading(false);
      await props.onFilesDrop?.(dropped);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not read these files. Try Upload a folder.',
      );
    } finally {
      setIsReading(false);
    }
  };
  document.addEventListener('dragenter', handleDragEnter);
  document.addEventListener('dragover', handleDragOver);
  document.addEventListener('dragleave', handleDragLeave);
  document.addEventListener('drop', handleDrop);
  document.addEventListener('dragend', reset);
  window.addEventListener('blur', reset);
  onCleanup(() => {
    document.removeEventListener('dragenter', handleDragEnter);
    document.removeEventListener('dragover', handleDragOver);
    document.removeEventListener('dragleave', handleDragLeave);
    document.removeEventListener('drop', handleDrop);
    document.removeEventListener('dragend', reset);
    window.removeEventListener('blur', reset);
  });
  return (
    <>
      <div
        class={cn(
          'fixed inset-0 z-80 bg-background/80 backdrop-blur pointer-events-none',
          isDragging() || isReading() ? 'block' : 'hidden',
        )}
      >
        <div class="flex items-center justify-center h-full text-center flex-col">
          <div class="i-tabler-folder-up text-6xl text-primary" />
          <div class="text-xl my-2 font-semibold">
            {isReading() ? 'Reading folder contents…' : 'Drop files or folders to upload'}
          </div>
          <div class="text-muted-foreground">
            Folder structure is preserved in the current destination.
          </div>
        </div>
      </div>
      <Show when={error()}>
        <div
          class="fixed bottom-4 left-4 z-90 max-w-sm rounded-lg border bg-background p-4 shadow-lg"
          role="alert"
        >
          <button
            type="button"
            class="float-right ml-3"
            aria-label="Dismiss folder upload error"
            onClick={() => setError(undefined)}
          >
            <span class="i-tabler-x size-4" />
          </button>
          {error()}
        </div>
      </Show>
    </>
  );
};
