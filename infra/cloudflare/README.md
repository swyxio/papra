# swyx Drive operations

Drive is a maintained AGPL Papra fork pinned to stable `@papra/app@26.6.2` (`cf0deb70cf7954853058b65d07b4cdebc84b916a`). The production application uses `apps/papra-worker` and Papra's Solid client. The upstream Node server is retained as upstream source; it is not deployed.

## Runtime

- Workers with static assets: UI, Google OAuth, current membership and folder authorization, metadata APIs.
- D1 `papra-drive`: users, spaces, folder ACLs, documents, immutable versions, comments, mentions, inbox, scoped credentials, upload/job state, keyword FTS5.
- Private R2 `papra-drive`: originals and bounded derivatives. Private `papra-drive-backups`: independent original copies, native receipts, consistent metadata snapshots. Public bucket access is disabled.
- Queues: durable native extraction, transcription, vision, indexing, original checksums and backup copying. D1 job generations and leases fence retries; hourly outbox repair resends pending work.
- Cloudflare Containers: Linux ffmpeg, Poppler and Tesseract. Containers receive expiring signed R2 capabilities; permanent credentials remain in Worker secrets. Native processing never calls AI providers.
- Workers AI: Whisper Turbo audio, Gemma 4 vision, BGE 768-dimensional embeddings, Llama 3.3 cited answers. Vectorize namespaces are home-folder IDs; permission and current-version checks run before snippet/model context access.
- Workflows: one daily consistent D1 metadata capture followed by durable paged export to R2 and clone cleanup.

## Access and document behavior

Only verified Google accounts with exact domains `ai.engineer`, `latent.space`, `smol.ai`, plus exact owner `shawnthe1@gmail.com`, are admitted. Each account owns a private personal space. Ordinary domain members join their matching team as members; existing elevated roles survive login. The owner joins all three teams. Personal ownership is checked independently of membership rows.

Each document has one home folder. Restricted ancestors require explicit reader/writer grants at every restricted level. Shortcuts do not grant access to the original. Team admins/personal owners manage external shares; public requests recheck the share creator's current authority, password unlock, expiry, enabled state and current original. Previously signed public R2 URLs expire within 60 seconds.

Replacements create new immutable versions under a permanent document ID. Active documents retain old versions indefinitely. Trash retains documents for 90 days; the scheduled purge removes expired originals and versions. Explicit permanent deletion is available from trash.

Uploads use browser-to-R2 multipart PUTs with three concurrent parts, bounded part buffers, local part checksums and provider-authoritative resume state. Reload and reselect the same file to resume. Completion validates every part size and atomically accepts the version/pointer; accepted objects can repair a lost completion response. Downloads bypass the application body. Raw inline previews are capped at 32 MiB; larger originals use bounded derivatives. Folder upload preserves browser-selected hierarchy. Chrome bulk export streams ZIP64 to disk with a metadata manifest.

Scoped credentials grant read or read/write within a selected folder subtree in one space, intersected with the creator's current access. Tokens are shown once, stored only as hashes, and revocable. Credentials do not grant sharing or ACL administration.

## Processing bounds and cost

Automatic native PDF/image processing caps inputs at 2 GiB and 250 pages. Audio/video tools range-read signed originals without downloading them wholesale to temporary disk; processing caps duration at six hours, audio at 72 five-minute mono chunks, frames at 12 and native execution at 12 minutes. Unsupported or over-limit originals remain downloadable with explicit processing status.

AI reservations cap automatic audio at six hours/day, vision at 100 images/day and document chat at 100 requests/day across the instance. These are application limits, not a promise of free processing. Exhaustion is recorded in job status; files and keyword search remain available. Private R2 backups consume additional storage.

## Release

Use Node 26 and pnpm. Build/typecheck/test the actual Worker and client, then deploy the merged public fork commit:

```sh
pnpm --filter @papra/worker typecheck
pnpm --filter @papra/worker test
pnpm --filter @papra/app-client typecheck
pnpm --filter @papra/app-client build
pnpm --filter @papra/worker exec wrangler deploy
```

Set `SOURCE_SHA` to the released commit and change `VERSION` for deployment checkpoints. Required stable secrets are `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Never commit or log them. The Google callback is exactly `https://drive.swyx.io/api/auth/callback/google`; the shared Tools client keeps its other callbacks.

The initial D1 schema is `apps/papra-worker/schema.sql`. It initializes a new empty database; do not rerun it against an existing deployment. Worker bindings, container definition and custom-domain target belong to `apps/papra-worker/wrangler.jsonc`. Source/build/deployment/hostname/provider verification are separate receipts in [VERIFICATION.md](VERIFICATION.md).

## Recovery

Daily Workflow snapshots write a complete manifest only after every table page and row count matches the captured clone. Each version has a separate original backup copy and an independent streamed checksum receipt. Restore metadata into a new D1 database, keep the same document/version IDs, restore backup originals to their recorded primary keys, then repoint bindings and verify permissions, FTS, permanent links and file hashes before using the restored deployment. D1 Time Travel is an additional provider recovery path.

Secrets and Google callback configuration must remain stable across recovery. A metadata manifest is not proof of successful restoration; consult executed restore receipts in VERIFICATION.md. Do not publish or deploy a partially restored snapshot.
