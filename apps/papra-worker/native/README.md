# Native processing

This container runs poppler, Tesseract, and ffmpeg for private Drive originals.
The Cloudflare Worker owns authentication, D1, queue retries, AI budgets, and
indexing. The container has no permanent R2 or AI credentials.

`POST /process` implements [protocol.ts](./protocol.ts). The queue consumer sends
one signed GET URL plus signed PUT targets under `derived/`. URLs must target
the configured account's private `papra-drive` bucket. Outputs stream from files
to R2 with byte counts and SHA-256 receipts. Do not log request payloads or URLs.
Use immutable per-job target keys; a retry can overwrite the same derived
outputs. Only commit returned receipts to D1 after the entire job succeeds.
After a failed attempt, ignore incomplete derived assets; originals remain
unchanged. `POST /hash` streams an original from either private bucket into an incremental SHA-256 digest, validates its actual byte count, and uses no temporary disk. It runs independently from media extraction and never invokes AI. `/health` and `/ping` report readiness.

Images and PDFs download to temporary disk with a 2 GiB bound. PDFs support up
to 250 pages and OCR pages with little embedded text. Text is bounded to 1 MiB.
Audio and video use ffprobe/ffmpeg directly against signed R2 URLs with HTTP
range requests, including originals larger than container disk. Processing
supports media up to 6 hours, 72 five-minute audio chunks and 12 video frames.
Each audio chunk is 16 kHz, mono, signed 16-bit PCM WAV, at most about 9.6 MB.
The consumer transcribes these chunks and adds each chunk's start time to word
or segment timestamps. Frame receipts contain source timestamps for vision and
search provenance. No model calls run in the image.

A job has a 12 minute deadline and one active job per container instance. Tool
failure or bounds violations produce stable errors; originals remain available
when processing cannot finish within these limits. Temporary files are removed
on success and failure. Presign URLs for at least 15 minutes, with a bounded
expiry, and configure queue batch size 1 to leave the consumer's documented
15 minute wall limit available to one job. Upload of originals is independent
of these processing limits.

Export `ImageProcessorContainer` **and `ContainerProxy`** from the Worker entry point, bind `PROCESSOR`,
and configure Wrangler:

```json
{
  "containers": [
    {
      "class_name": "ImageProcessorContainer",
      "image": "./native/Dockerfile",
      "image_build_context": "./native",
      "instance_type": "standard-3",
      "max_instances": 2
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "PROCESSOR", "class_name": "ImageProcessorContainer" }]
  },
  "migrations": [{ "tag": "native-v1", "new_sqlite_classes": ["ImageProcessorContainer"] }]
}
```

Call `getContainer(env.PROCESSOR, jobId).fetch(new Request('http://processor/process',
{method:'POST',body:JSON.stringify(job)}))` only in the queue consumer. The
Container outbound access is denied by default. The maintained HTTPS interception
proxy permits only signed GET/HEAD capabilities in `papra-drive` or `papra-drive-backups` and signed PUT
capabilities under `derived/`; nested media URLs cannot widen these permissions.
The entrypoint trusts Cloudflare's runtime-injected CA and drops privileges to
the `node` user before processing. No certificate checks are disabled. The
maintained `@cloudflare/containers` class starts instances on demand and holds
them awake during in-flight responses. The image's `.dockerignore` permits only
the Dockerfile, server, video policy, and entrypoint, excluding local credentials and fixtures.

Verification:

```sh
node --test native/server.test.mjs
docker build --platform linux/amd64 -t papra-native native
docker run --rm -p 127.0.0.1:18080:8080 papra-native
```

Provider contracts verified against installed `@cloudflare/containers@0.3.7`
and Wrangler's configuration schema. Current references:
[Container interface](https://developers.cloudflare.com/containers/reference/container-class/),
[instance limits](https://developers.cloudflare.com/containers/platform/limits/),
[deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/),
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/).
Container image build and rollout are separate from Worker publication; verify
the deployed processing path before reporting it live.

## Video playback previews

`POST /video/probe` records codec, display dimensions, duration, pixel format,
frame rate, and bitrate. Compatible, modest-bitrate MP4/WebM originals play
without conversion. Videos needing conversion and shorter than 15 minutes
queue a 720p preview; longer videos prepare one on opening or explicit request.
1080p is optional. Preview encoding only reduces dimensions, preserves aspect
ratio and portrait orientation, caps frame rate at 30 fps, and emits H.264/AAC
MP4 with fast-start. The decoded output is checked against the original display
dimensions so no preview can upscale. Originals are never replaced.

`POST /video/convert` streams whitespace heartbeats while encoding, then a JSON
receipt or safe error envelope. Disconnects abort processing. Each conversion
writes a lease-specific derived key; the outbound proxy checks the current job,
generation, lease and document state before accepting a write. Ready previews
are reused. One video conversion runs at a time, with two CPU cores per native
instance to handle high-resolution source decoding.

The Worker reserves estimated compute before each attempt and settles measured
request time at the provisioned CPU/memory/disk rate. The monthly preview
compute limit is $10; this estimate excludes R2 storage, Workers AI and other
native processing. It is an application processing limit, not a Cloudflare
billing cap.
