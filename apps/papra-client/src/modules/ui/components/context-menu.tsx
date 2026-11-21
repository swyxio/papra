import type { ParentProps } from 'solid-js';
import { ContextMenu } from '@kobalte/core/context-menu';
import { cn } from '@/modules/shared/style/cn';

export { ContextMenu };

export function ContextMenuContent(props: ParentProps<{ class?: string }>) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        class={cn(
          'min-w-44 z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none',
          props.class,
        )}
      >
        {props.children}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}
