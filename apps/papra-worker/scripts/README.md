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

Default sizes are 1 GiB, 6.25 GiB, and 12.25 GiB. `--sizes-gib=0.125` selects a bounded first smoke. The harness checks the Chrome account before creating one uniquely named disposable folder in its personal space. It neither closes Chrome nor changes membership. Cookies, credentials, signed URLs and personal email are never included in receipts.

At least three successful R2 ETag responses trigger interruption. The harness confirms stored parts through the live API, preserves browser localStorage, and emits paths to `checkpoint.request.json` and `checkpoint.ready.json`. Root redeploys with a new Worker `VERSION`, then writes the ready file as `{"version":"NEW_VERSION"}`. The harness checks the new live version and unchanged D1 session/provider parts before reloading and reselecting the same file. It rejects any network resend of a provider-confirmed part; in-flight canceled parts may restart. Every size requests its own checkpoint.

Receipts record exact size, acknowledged/offered part bytes, skipped bytes, request concurrency, upload wall time including the deployment pause, upload time excluding that pause, browser source SHA-256, first/tail range status 206 and Content-Range, full browser download size/hash/time, and fixed chunk memory observations. Partial canceled wire bytes cannot be measured from browser request metadata.

Only each run's exact synthetic document IDs are trashed and permanently purged after an integrity receipt is saved. Successful runs delete their local source and empty folder. Failed runs preserve only their synthetic sources and folder/objects for inspection; the harness does not retry entire transfers or touch unrelated files. A prepared receipt or unit test is not provider, performance, authenticated login, or live deployment proof.
