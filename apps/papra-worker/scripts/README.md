The benchmark imports the shipped browser `multipartUpload` and calls the live Worker API. It sends parts directly from Chrome to R2, then reads local source and complete R2 download streams with incremental SHA-256. The synthetic sources use sparse zero extents and deterministic 64 KiB markers every 32 MiB and at the tail; measurements describe synthetic binary transfers rather than representative media.

Use Node 26 from the Worker directory:

```sh
node scripts/drive-benchmark.ts --prepare
```

Preparation makes no external calls. It bundles the actual client uploader, generates a small disposable source, checks independent Node and browser-library SHA-256 agreement, validates marker signatures, and saves a private receipt under `~/.config/papra-drive/benchmarks`.

After root confirms deployment and authentication are ready, use the existing Chrome CDP endpoint and the exact verified account/personal organization:

```sh
node scripts/drive-benchmark.ts --live --production-ready \
  --expected-email=ACCOUNT --organization-id=PERSONAL_ORG \
  --cdp=http://127.0.0.1:PORT
```

Default sizes are 1 GiB, 6.25 GiB, and 12.25 GiB. `--sizes-gib=0.25` selects a bounded first smoke. The harness checks the Chrome account before creating one uniquely named disposable folder in its personal space. It neither closes Chrome nor changes membership. Cookies, credentials, signed URLs and personal email are never included in receipts.

At least three successful R2 ETag responses trigger interruption. The harness confirms stored parts through the live API, preserves browser localStorage, and emits paths to `checkpoint.request.json` and `checkpoint.ready.json`. Root redeploys with a new Worker `VERSION`, then writes the ready file as `{"version":"NEW_VERSION"}`. The harness checks the new live version and unchanged D1 session/provider parts before reloading and reselecting the same file. It rejects any network resend of a provider-confirmed part; in-flight canceled parts may restart. Every size requests its own checkpoint.

Receipts record exact size, acknowledged/offered part bytes, skipped bytes, request concurrency, upload wall time including the deployment pause, upload time excluding that pause, browser source SHA-256, first/tail range status 206 and Content-Range, full browser download size/hash/time, and fixed chunk memory observations. Partial canceled wire bytes cannot be measured from browser request metadata.

Only each run's exact synthetic document IDs are trashed and permanently purged after an integrity receipt is saved. Successful runs delete their local source and empty folder. Failed runs preserve only their synthetic sources and folder/objects for inspection; the harness does not retry entire transfers or touch unrelated files. A prepared receipt or unit test is not provider, performance, authenticated login, or live deployment proof.

For the current release benchmark, the owner’s already verified Chrome session creates a unique empty personal child folder and a read/write service credential expiring in three hours. The separate official benchmark Chrome profile uses that credential rather than Google cookies. Pass `--service-credential-file=/PRIVATE/PATH.json` along with the exact owner email, personal organization ID, and `--cdp=http://127.0.0.1:9223`. The private mode-600 JSON contains `origin`, `token`, `credentialId`, `organizationId`, `folderId`, `userId`, `email`, `emailVerified`, `personalOwnerId`, `expiresAt`, and `permissions`. No credentials are copied from another browser profile.

The harness validates the exact verified owner metadata, token expiry within three hours, and read/write-only scope. The live API must reveal only one empty non-home folder created by that owner. Authorization is injected only into app API requests; API context redirects are disabled, and R2 requests receive no authorization header. The token stays in Node memory and its private input file, never in the test page or localStorage. Receipts explicitly identify service credential authentication separately from Google login proof. The owner revokes the credential through the normal UI after the run; deleting its empty folder also removes its effective folder access.

The first smoke uses `--keep-folder` so the approved scoped credential can be reused for the three larger transfers without creating another credential. The final invocation omits this flag and removes the empty folder after verification. Before purge, each transfer waits up to ten minutes for the server version’s original SHA-256 to match the independently generated source/download. The receipt records the permanent version ID, extraction status/error, and hash status. A timeout preserves the exact synthetic document and distinguishes transfer integrity from a pending processing pipeline.

Once the server hash matches, the harness emits `backup.request.json` and waits for `backup.ready.json`. Hosting independently streams the backup object and writes a private receipt, then the ready file `{"verified":true,"wholeObjectStreamVerified":true,"versionId":"...","sha256":"...","sizeBytes":0,"receiptPath":"/PRIVATE/RECEIPT"}`. The exact size, version and hash must match. Provider verification pending after ten minutes preserves the synthetic object for inspection rather than reporting a successful backup or purging evidence.
