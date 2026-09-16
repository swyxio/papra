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

For a Worker/client-only release with the native image unchanged, deploy with `wrangler deploy --containers-rollout=none`; this preserves the already verified Container rollout. Rebuild and verify the Container image only when its source changes.

Set `SOURCE_SHA` to the released commit and change `VERSION` for deployment checkpoints. Required stable secrets are `AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Never commit or log them. The Google callback is exactly `https://drive.swyx.io/api/auth/callback/google`; the shared Tools client keeps its other callbacks.

The initial D1 schema is `apps/papra-worker/schema.sql`. It initializes a new empty database; do not rerun it against an existing deployment. Worker bindings, container definition and custom-domain target belong to `apps/papra-worker/wrangler.jsonc`. Source/build/deployment/hostname/provider verification are separate receipts in [VERIFICATION.md](VERIFICATION.md).

## Recovery

Daily Workflow snapshots write a complete manifest only after every table page and row count matches the captured clone. Each version has a separate original backup copy and an independent streamed checksum receipt. Restore metadata into a new D1 database, keep the same document/version IDs, restore backup originals to their recorded primary keys, then repoint bindings and verify permissions, FTS, permanent links and file hashes before using the restored deployment. D1 Time Travel is an additional provider recovery path.

Secrets and Google callback configuration must remain stable across recovery. A metadata manifest is not proof of successful restoration; consult executed restore receipts in VERIFICATION.md. Do not publish or deploy a partially restored snapshot.

## Native PDF signing

Native PDF signing replaces Documenso as a runtime dependency. A personal owner/team admin can place signature/name/date/text fields and request signatures from up to 20 recipients. Each bearer link authorizes one recipient on the pinned PDF revision. Sending is the sender's PDF approval; clicking Sign document adopts the entered name and consents to electronic signing. All signed recipients are sealed with the existing signing certificate, and the sealed PDF contains a signing record. Source and executed versions are preserved independently. Accepted signatures, email outbox records and sealing leases live in D1. Signed PDFs and audit JSON are written to both private R2 buckets before completion is recorded. Files are bounded to 10 MiB and 100 pages. The existing self-signed sealing certificate does not establish independently verified signer identity or reader-trusted certificate identity.

Initialize signing tables on the existing D1 database with `wrangler d1 execute papra-drive --remote --file signing.sql` from apps/papra-worker. Do not rerun the full initial schema. Worker secrets: SIGNING_P12, SIGNING_PASSPHRASE, RESEND_API_KEY, SIGNING_FROM. Existing sealing and mail credentials are reused; they are not included in source or client assets. Signing requests, recipients and mail outbox tables are included in metadata snapshots.

### Native authoring

`Create document` starts a blank document, invoice, or agreement outline. Tiptap stores native JSON and pdfmake renders paginated PDF text and tables directly inside the Worker. `Save PDF` retains both the original source and an immutable PDF version; `Save and request signatures` publishes changes before field placement. Uploaded PDFs remain PDFs; this editor does not pretend to reconstruct their source or round-trip Word files.

Apply `apps/papra-worker/authoring.sql` for `authored_versions` and `document_edit_locks`. Sources are bounded to 200 KB, 5,000 nodes, depth 20, and rectangular tables with 100 rows/10 columns. A two-minute editing lease renews every 40 seconds; publication also compares the current PDF version. Both buckets must accept the PDF before metadata publication. Lost response retries preserve one version. Logical metadata snapshots retain native JSON; trash purge deletes both PDF copies and cascades native sources.

Editor options considered: Tiptap and Lexical for native documents; SuperDoc for DOCX-centric fidelity; Collabora/LibreOffice and ONLYOFFICE for full Office document servers. Tiptap meets this layer without operating another office server. SuperDoc remains a Word-interoperability candidate; its browser export produces DOCX and does not itself complete PDF conversion.

Native signing live proof (2026-09-16): synthetic, explicitly non-binding `doc_37264732ac7c4a84a9cce440`, request `sigreq_306ae57b679d4ecda96ff38f`, completed through Chrome recipient UI. Two-page sealed PDF, 31,195 bytes, SHA-256 `464f5c6e73696b54e98e2c170f1dafa1338c39028c590fe07a7e0272ba22dc24`. OpenSSL CMS verified the complete byte range including the appended signing record. This verifies artifact integrity, not independent recipient identity or public certificate trust.

### Review before signing

Apply `apps/papra-worker/reviews.sql`. Personal owners and team admins create document-only bearer review links lasting 30 days. Reviewers can comment on uploaded PDFs or submit edited native sources as separate proposals. Writers accept/reject proposals; accepting changes saves an immutable PDF and its source atomically. The UI shows word differences and the full proposed document for formatting/table review. These are whole-revision proposals, not Word tracked-change round trips. Comments must be resolved and proposals accepted/rejected before sending; creating a signing request closes its review links atomically. Revocation, sender removal, document trash, and expiry close public access.

### Documenso retirement (2026-09-16)

`sign.swyx.io` now redirects to `https://drive.swyx.io/sign` through the Cloudflare `papra-sign-redirect` Worker. Its source and custom-domain target are in this directory. The former Railway CNAME `sign → 422j0swl.up.railway.app` was replaced with the Worker custom domain. Old signing paths are intentionally retired. Native signing does not call Documenso.

The six former envelopes were all explicitly TEST ONLY: two completed, three pending team requests and one personal draft. Five team documents, seven immutable PDF versions and both completed sealed PDFs were imported into their matching AIE, Latent Space and Smol spaces. The personal draft remains in the private operator recovery archive rather than being exposed to a team. Old pending signing links were not reissued.

Before retirement, the PostgreSQL dump was restored into a temporary database and all six envelopes were recovered. All eight source PDFs and the 211,933-byte database dump were copied to private `papra-drive-backups/retired/documenso/2026-09-16/`, with complete SHA-256 readbacks. Its manifest is written last. Stable recovery credentials and the original certificate remain in owner-only local configuration, outside source control.

All four Railway deployments (web, backup, Redis and Postgres) were stopped. Project `55ef0045-dc4a-468d-98e1-84edf2dafcae` deletion was accepted, with provider `deletedAt: 2026-09-18T18:52:31.376Z`; this is scheduled removal, not proof that delayed deletion has completed. The public Documenso source fork remains available for its former modified instance.
