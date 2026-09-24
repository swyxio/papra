import { PublicHeader } from '@/modules/ui/layouts/public.layout';
import { SharedTranscriptPanel } from '../components/shared-transcript.component';
import type { PublicSharedDocument } from '../document-share-links.types';
import { TranscriptionProgress } from '@/modules/documents/components/transcription-progress.component';
import { transcriptionActive } from '@/modules/documents/document-processing.services';
import type { Component } from 'solid-js';
import { formatBytes } from '@corentinth/chisels';
import { useParams } from '@solidjs/router';
import { useMutation, useQuery } from '@tanstack/solid-query';
import { createEffect, createSignal, onCleanup, Match, Show, Switch } from 'solid-js';
import { DocumentBlobPreview } from '@/modules/documents/components/document-preview.component';
import { getDocumentIcon } from '@/modules/documents/document.models';
import { useI18n } from '@/modules/i18n/i18n.provider';
import { useAboutDialog } from '@/modules/shared/components/about-dialog';
import { isHttpErrorWithStatusCode } from '@/modules/shared/http/http-errors';
import { cn } from '@/modules/shared/style/cn';
import { ThemeSwitcher } from '@/modules/theme/theme-switcher.component';
import { Button } from '@/modules/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/modules/ui/components/dropdown-menu';
import { createToast } from '@/modules/ui/components/sonner';
import { TextField, TextFieldLabel, TextFieldRoot } from '@/modules/ui/components/textfield';
import { LanguageSwitcher } from '@/modules/ui/layouts/sidenav.layout';
import {
  fetchSharedTranscript,
  fetchSharedDocument,
  fetchSharedDocumentDirect,
  fetchSharedDocumentFile,
  verifySharePassword,
} from '../document-share-links.services';

function isPreviewable(mimeType: string) {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

const PasswordGate: Component<{
  token: string;
  onUnlocked: (args: { accessToken: string }) => void;
}> = (props) => {
  const { t } = useI18n();
  const [getPassword, setPassword] = createSignal('');

  const verifyMutation = useMutation(() => ({
    mutationFn: async () => verifySharePassword({ token: props.token, password: getPassword() }),
    onSuccess: ({ accessToken }) => props.onUnlocked({ accessToken }),
    onError: (error) => {
      const message = isHttpErrorWithStatusCode({ error, statusCode: 429 })
        ? t('document-share-links.public.password.too-many-attempts')
        : t('document-share-links.public.password.invalid');

      createToast({ type: 'error', message });
    },
  }));

  return (
    <div class="flex flex-col gap-4 max-w-lg mx-auto my-6 md:my-24 px-6">
      <div class="flex flex-col items-center gap-2 text-center">
        <div class="i-tabler-lock size-8 text-muted-foreground" />
        <h1 class="text-lg font-semibold">{t('document-share-links.public.password.title')}</h1>
        <p class="text-sm text-muted-foreground">
          {t('document-share-links.public.password.description')}
        </p>
      </div>

      <form
        class="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          verifyMutation.mutate();
        }}
      >
        <TextFieldRoot class="flex flex-col gap-1">
          <TextFieldLabel class="sr-only" for="share-password">
            {t('document-share-links.public.password.label')}
          </TextFieldLabel>
          <TextField
            type="password"
            id="share-password"
            autofocus
            autocomplete="current-password"
            placeholder={t('document-share-links.public.password.placeholder')}
            value={getPassword()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </TextFieldRoot>

        <Button type="submit" isLoading={verifyMutation.isPending} disabled={getPassword() === ''}>
          {t('document-share-links.public.password.submit')}
        </Button>
      </form>
    </div>
  );
};

const SharedDocumentCard: Component<{
  token: string;
  accessToken: string | undefined;
  document: PublicSharedDocument;
}> = (props) => {
  const { t } = useI18n();

  const isMedia = () => /^(audio|video)\//.test(props.document.mimeType);
  let player: HTMLMediaElement | undefined;
  let resumeAt = 0;
  const [mediaError, setMediaError] = createSignal(false);
  const mediaQuery = useQuery(() => ({
    queryKey: ['share-link', props.token, 'media', props.accessToken],
    queryFn: async () =>
      fetchSharedDocumentDirect({
        token: props.token,
        accessToken: props.accessToken,
        mode: 'media',
      }),
    enabled: !props.document.upload && isMedia(),
    retry: false,
    refetchOnWindowFocus: false,
  }));
  const transcriptQuery = useQuery(() => ({
    queryKey: ['share-link', props.token, 'transcript', props.accessToken],
    queryFn: async () =>
      fetchSharedTranscript({ token: props.token, accessToken: props.accessToken }),
    enabled: props.document.transcription?.status === 'ready',
    retry: 1,
    refetchOnWindowFocus: false,
  }));
  const seek = (seconds: number) => {
    if (player) {
      player.currentTime = seconds;
      player.focus();
    }
  };
  const loaded = () => {
    setMediaError(false);
    if (player && resumeAt) player.currentTime = resumeAt;
  };
  const failed = () => {
    resumeAt = player?.currentTime ?? 0;
    setMediaError(true);
  };
  const downloadMutation = useMutation(() => ({
    mutationFn: async () =>
      fetchSharedDocumentDirect({
        token: props.token,
        accessToken: props.accessToken,
        mode: 'download',
      }),
    onSuccess: ({ url }) => {
      if (url) {
        const link = window.document.createElement('a');
        link.href = url;
        link.click();
      }
    },
    onError: () =>
      createToast({ type: 'error', message: t('document-share-links.public.download-error') }),
  }));

  const previewQuery = useQuery(() => ({
    queryKey: ['share-link', props.token, 'file', props.accessToken],
    queryFn: async () =>
      fetchSharedDocumentFile({ token: props.token, accessToken: props.accessToken }),
    enabled:
      !props.document.upload &&
      props.document.size <= 32 * 1024 ** 2 &&
      isPreviewable(props.document.mimeType),
    retry: false,
    refetchOnWindowFocus: false,
  }));

  const derivativeQuery = useQuery(() => ({
    queryKey: ['share-link', props.token, 'derivative', props.accessToken],
    queryFn: async () =>
      fetchSharedDocumentDirect({
        token: props.token,
        accessToken: props.accessToken,
        mode: 'preview',
      }),
    enabled: !props.document.upload && !isMedia() && props.document.size > 32 * 1024 ** 2,
    retry: false,
    refetchInterval: 5000,
  }));
  createEffect(() => {
    document.title = `${props.document.name} — SwyxDrive`;
  });
  onCleanup(() => {
    document.title = 'SwyxDrive — Documents, sharing & signing';
  });

  return (
    <div>
      <div class="flex flex-col md:flex-row items-center gap-2 md:gap-4 max-w-5xl px-6 w-full mx-auto py-12 border-b">
        <div class="bg-muted flex items-center justify-center size-12 rounded-lg shrink-0">
          <div class={cn(getDocumentIcon({ document: props.document }), 'size-7 text-primary')} />
        </div>

        <div class="text-center md:text-left">
          <h1 class="text-xl font-semibold break-all">{props.document.name}</h1>
          <p class="text-sm text-muted-foreground">
            {formatBytes({ bytes: props.document.size, base: 1000 })}
          </p>
        </div>

        <div class="md:ml-auto">
          <Button
            disabled={!!props.document.upload}
            onClick={() => downloadMutation.mutate()}
            isLoading={downloadMutation.isPending}
          >
            <div class="i-tabler-download size-4 mr-2" />
            {t('document-share-links.public.download')}
          </Button>
        </div>
      </div>

      <Show when={props.document.upload}>
        {(upload) => (
          <div class="max-w-lg mx-auto px-6 py-12 space-y-4 text-center" role="status">
            <div class="i-tabler-cloud-upload size-10 text-primary mx-auto" />
            <h2 class="text-xl font-semibold">Upload in progress</h2>
            <p class="text-muted-foreground">
              This file is still uploading. It will become available here automatically.
            </p>
            <p>
              {upload().total
                ? `${Math.floor((upload().bytes / upload().total) * 100)}% uploaded`
                : 'Finalizing upload…'}
            </p>
            <progress
              class="w-full accent-primary"
              aria-label="Upload progress"
              max={Math.max(1, upload().total)}
              value={upload().bytes}
            />
            <Show
              when={upload().interrupted || Date.now() - Date.parse(upload().updatedAt) > 30000}
            >
              <p class="text-sm text-muted-foreground">
                Waiting for the uploader to reconnect. Progress is the last reported amount.
              </p>
            </Show>
            <Show when={upload().total > 0 && upload().bytes >= upload().total}>
              <p class="text-sm text-muted-foreground">Finalizing the file…</p>
            </Show>
          </div>
        )}
      </Show>
      <div class="p-6 flex justify-center max-w-5xl mx-auto w-full">
        <Show when={mediaQuery.data?.url}>
          {(url) => (
            <Show
              when={props.document.mimeType.startsWith('video/')}
              fallback={
                <audio
                  ref={(element) => {
                    player = element;
                  }}
                  controls
                  preload="metadata"
                  src={url()}
                  aria-label="Audio player"
                  class="w-full"
                  onLoadedMetadata={loaded}
                  onError={failed}
                />
              }
            >
              <video
                ref={(element) => {
                  player = element;
                }}
                controls
                playsinline
                preload="metadata"
                src={url()}
                aria-label="Video player"
                class="w-full max-h-75vh bg-black rounded-md"
                onLoadedMetadata={loaded}
                onError={failed}
              />
            </Show>
          )}
        </Show>
        <Show when={derivativeQuery.data?.url}>
          {(url) => <img src={url()} alt="File preview" class="max-w-full" />}
        </Show>
        <Show when={previewQuery.data?.blob}>
          {(getBlob) => (
            <div class="rounded-md overflow-hidden w-full min-h-1200px">
              <DocumentBlobPreview blob={getBlob()} mimeType={props.document.mimeType} />
            </div>
          )}
        </Show>
      </div>
      <Show when={mediaError() || mediaQuery.isError}>
        <div class="max-w-5xl mx-auto px-6 pb-4 flex items-center gap-3 text-sm">
          <p>Could not play this file. Reload the player or download the original.</p>
          <Button variant="outline" size="sm" onClick={() => void mediaQuery.refetch()}>
            Reload player
          </Button>
        </div>
      </Show>
      <Show when={props.document.transcription}>
        {(state) => (
          <div class="max-w-5xl mx-auto px-6 pt-6">
            <TranscriptionProgress state={state()} />
          </div>
        )}
      </Show>
      <Show when={props.document.transcription?.status === 'ready'}>
        <Show
          when={transcriptQuery.data?.transcript}
          fallback={
            <div class="max-w-5xl mx-auto px-6 py-6 text-sm" role="status">
              <Show when={transcriptQuery.isError} fallback={<>Loading transcript…</>}>
                <p>Could not load the transcript.</p>
                <Button variant="outline" size="sm" onClick={() => void transcriptQuery.refetch()}>
                  Retry transcript
                </Button>
              </Show>
            </div>
          }
        >
          {(transcript) => (
            <SharedTranscriptPanel
              transcript={transcript()}
              name={props.document.name}
              onSeek={mediaQuery.data?.url ? seek : undefined}
            />
          )}
        </Show>
      </Show>
    </div>
  );
};

const StatusMessage: Component<{ icon: string; title: string; description: string }> = (props) => (
  <div class="flex flex-col items-center gap-2 text-center mt-12 px-6">
    <div class={`${props.icon} size-8 text-muted-foreground`} />
    <h1 class="text-lg font-semibold">{props.title}</h1>
    <p class="text-sm text-muted-foreground">{props.description}</p>
  </div>
);

export const SharedDocumentPage: Component = () => {
  const { t } = useI18n();
  const params = useParams();
  const [getAccessToken, setAccessToken] = createSignal<string | undefined>(undefined);
  const aboutDialog = useAboutDialog();

  const documentQuery = useQuery(() => ({
    queryKey: ['share-link', params.token, 'document', getAccessToken()],
    refetchInterval: (query) =>
      query.state.data?.document.upload ||
      transcriptionActive(query.state.data?.document.transcription)
        ? 3000
        : false,
    queryFn: async () =>
      fetchSharedDocument({ token: params.token, accessToken: getAccessToken() }),
    retry: false,
  }));

  return (
    <div>
      <PublicHeader>
        <DropdownMenu>
          <DropdownMenuTrigger
            as={Button}
            variant="outline"
            aria-label={t('user-menu.trigger.label')}
            size="icon"
          >
            <div class="i-tabler-dots size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-48">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger class="flex items-center gap-2 cursor-pointer">
                <div class="i-tabler-language size-4 text-muted-foreground" />
                {t('user-menu.language')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="min-w-48">
                <LanguageSwitcher />
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger class="flex items-center gap-2 cursor-pointer">
                <div class="i-tabler-sun-moon size-4 text-muted-foreground" />
                {t('user-menu.theme')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="min-w-48">
                <ThemeSwitcher />
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem
              onClick={() => aboutDialog.open()}
              class="flex items-center gap-2 cursor-pointer"
            >
              <div class="i-tabler-info-circle size-4 text-muted-foreground" />
              {t('user-menu.about')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PublicHeader>

      <Switch>
        <Match when={documentQuery.isPending}>
          <div class="flex justify-center py-8">
            <div class="i-tabler-loader-2 size-6 animate-spin text-muted-foreground" />
          </div>
        </Match>

        <Match when={documentQuery.isSuccess}>
          <SharedDocumentCard
            token={params.token}
            accessToken={getAccessToken()}
            document={documentQuery.data!.document}
          />
        </Match>

        <Match
          when={
            documentQuery.isError &&
            isHttpErrorWithStatusCode({ error: documentQuery.error, statusCode: 401 })
          }
        >
          <PasswordGate
            token={params.token}
            onUnlocked={({ accessToken }) => setAccessToken(accessToken)}
          />
        </Match>

        <Match
          when={
            documentQuery.isError &&
            isHttpErrorWithStatusCode({ error: documentQuery.error, statusCode: 410 })
          }
        >
          <StatusMessage
            icon="i-tabler-link-off"
            title={t('document-share-links.public.gone.title')}
            description={t('document-share-links.public.gone.description')}
          />
        </Match>

        <Match when={documentQuery.isError}>
          <StatusMessage
            icon="i-tabler-file-off"
            title={t('document-share-links.public.not-found.title')}
            description={t('document-share-links.public.not-found.description')}
          />
        </Match>
      </Switch>
    </div>
  );
};
