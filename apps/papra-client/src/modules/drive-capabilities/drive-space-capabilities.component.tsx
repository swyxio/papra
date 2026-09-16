import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import { fetchFolders, folderPath } from '../drive-collaboration/drive-collaboration.services';
import { Button } from '../ui/components/button';
import {
  createServiceCredential,
  fetchServiceCredentials,
  revokeServiceCredential,
} from './drive-capabilities.services';
import { DriveError, DriveEvidence, driveFieldClass } from './drive-evidence.component';

export function DriveSpaceCapabilities(props: { organizationId: string }) {
  const [folders] = createResource(() => props.organizationId, fetchFolders);
  const [credentials, { refetch }] = createResource(
    () => props.organizationId,
    fetchServiceCredentials,
  );
  const [name, setName] = createSignal('');
  const [folderId, setFolderId] = createSignal('');
  const [write, setWrite] = createSignal(false);
  const [days, setDays] = createSignal(30);
  const [issued, setIssued] = createSignal<{ name: string; token: string }>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  createEffect(() => {
    const organizationId = props.organizationId;
    if (organizationId) {
      setIssued(undefined);
      setFolderId('');
      setName('');
      setWrite(false);
      setError(undefined);
    }
  });
  const create = async () => {
    if (busy() || !name().trim() || !folderId()) return;
    const org = props.organizationId;
    setBusy(true);
    setError(undefined);
    setIssued(undefined);
    try {
      const result = await createServiceCredential(org, {
        name: name().trim(),
        folderId: folderId(),
        permissions: write() ? ['read', 'write'] : ['read'],
        expiresAt: new Date(Date.now() + days() * 86400000).toISOString(),
      });
      if (org === props.organizationId) {
        setIssued({ name: result.credential.name, token: result.token });
        await refetch();
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (credentialId: string) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    setIssued(undefined);
    try {
      await revokeServiceCredential(props.organizationId, credentialId);
      await refetch();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(issued()?.token ?? '');
    } catch {
      setError(new Error('Clipboard access failed. Select and copy the token below.'));
    }
  };
  return (
    <div class="space-y-6">
      <DriveEvidence organizationId={props.organizationId} />
      <section class="space-y-4 rounded-lg border p-4">
        <h2 class="text-lg font-semibold">Service credentials</h2>
        <p class="text-sm text-muted-foreground">
          Give an automation access to one folder and its subfolders. Your current access still
          applies. Tokens are shown once and can be revoked here.
        </p>
        <DriveError error={error() ?? credentials.error ?? folders.error} />
        <Show when={!folders.loading && folders()?.folders.some((folder) => folder.canWrite)}>
          <form
            class="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label class="block text-sm font-medium">
              Name
              <input
                class={`${driveFieldClass} mt-1`}
                required
                maxLength={100}
                value={name()}
                placeholder="Invoice importer"
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label class="block text-sm font-medium">
              Folder
              <select
                aria-label="Folder"
                class={`${driveFieldClass} mt-1`}
                required
                value={folderId()}
                onChange={(event) => setFolderId(event.currentTarget.value)}
              >
                <option value="">Choose a folder</option>
                <For each={folders()?.folders.filter((folder) => folder.canWrite)}>
                  {(folder) => (
                    <option value={folder.id}>
                      {folderPath(folder, folders()?.folders ?? [])}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="block text-sm font-medium">
              Permission
              <select
                class={`${driveFieldClass} mt-1`}
                value={write() ? 'write' : 'read'}
                onChange={(event) => setWrite(event.currentTarget.value === 'write')}
              >
                <option value="read">Read files</option>
                <option value="write">Read and write files</option>
              </select>
            </label>
            <label class="block text-sm font-medium">
              Expires in
              <select
                class={`${driveFieldClass} mt-1`}
                value={days()}
                onChange={(event) => setDays(Number(event.currentTarget.value))}
              >
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
              </select>
            </label>
            <Button type="submit" isLoading={busy()} disabled={!name().trim() || !folderId()}>
              Create credential
            </Button>
          </form>
        </Show>
        <Show when={issued()}>
          {(value) => (
            <div class="space-y-2 rounded-md border p-3">
              <p class="font-medium">Save the token for {value().name}</p>
              <p class="text-sm text-muted-foreground">
                Use it as an Authorization: Bearer token. It will not be shown again after leaving
                this page.
              </p>
              <textarea
                class={driveFieldClass}
                rows={3}
                readOnly
                aria-label="New service credential token"
                value={value().token}
                onFocus={(event) => event.currentTarget.select()}
              />
              <div class="flex gap-2">
                <Button variant="outline" onClick={() => void copyToken()}>
                  Copy token
                </Button>
                <Button variant="ghost" onClick={() => setIssued(undefined)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </Show>
        <Show when={credentials.loading}>
          <p role="status" class="text-sm">
            Loading credentials…
          </p>
        </Show>
        <Show when={!credentials.loading && credentials()}>
          {(value) => (
            <ul class="divide-y">
              <For
                each={value().credentials}
                fallback={
                  <li class="text-sm text-muted-foreground">
                    You have no service credentials in this space.
                  </li>
                }
              >
                {(credential) => (
                  <li class="space-y-1 py-3 text-sm">
                    <p class="font-medium">{credential.name}</p>
                    <p class="break-words text-muted-foreground">
                      {folders()?.folders.find((folder) => folder.id === credential.folderId)
                        ?.name ?? 'Folder unavailable'}{' '}
                      · {credential.permissions.join(' and ')} ·{' '}
                      {credential.revokedAt
                        ? 'Revoked'
                        : credential.expiresAt &&
                            new Date(credential.expiresAt).getTime() <= Date.now()
                          ? 'Expired'
                          : credential.expiresAt
                            ? `Expires ${new Date(credential.expiresAt).toLocaleString()}`
                            : 'No expiry'}
                    </p>
                    <Show when={!credential.revokedAt}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy()}
                        onClick={() => void revoke(credential.id)}
                      >
                        Revoke credential
                      </Button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </section>
    </div>
  );
}
