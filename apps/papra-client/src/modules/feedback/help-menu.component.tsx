import { useCurrentUser } from '@/modules/users/composables/useCurrentUser';
import { A } from '@solidjs/router';
import { createSignal, Show } from 'solid-js';
import { Button } from '@/modules/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@/modules/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/modules/ui/components/dropdown-menu';
import { FeedbackForm } from './report.component';

function ReviewLink() {
  const user = useCurrentUser();
  return (
    <Show when={user.hasPermission('feedback:review')}>
      <DropdownMenuItem as={A} href="/feedback/review">
        Feedback review
      </DropdownMenuItem>
    </Show>
  );
}

export function HelpMenu(props: { showReview?: boolean }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="ghost" size="sm" aria-label="Help">
          Help
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setOpen(true)}>Report a problem</DropdownMenuItem>
          <Show when={props.showReview}>
            <ReviewLink />
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Report a problem</DialogTitle>
          <FeedbackForm operation="web-help" diagnostics={{ stage: 'help' }} />
        </DialogContent>
      </Dialog>
    </>
  );
}
