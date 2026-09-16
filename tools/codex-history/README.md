# Private Codex history archival

This maintenance workflow uploads inactive session logs to the owner's private swyx organization in Papra Drive. It is intentionally bound to the verified personal organization and Cloudflare account in `cloud.mjs`; it cannot silently target another team.

Run all commands from the repository root. Store the destination outside Git with directory mode 700. Wrangler's existing OAuth session and the existing restricted R2 credentials stay in `~/.config/papra-drive`, with file mode 600. The importer generates one temporary six-hour credential restricted to the new archive folder, and revokes it when finished. Never commit or print that credential, source logs, or generated archives.

1. `python3 tools/codex-history/archive.py plan --destination PRIVATE_STAGE` freezes sessions whose database activity and file modification times are older than four weeks.
2. `python3 tools/codex-history/archive.py pack --destination PRIVATE_STAGE` creates lossless bounded gzip tar archives with embedded metadata and SHA-256 checksums. It verifies every original byte locally.
3. `python3 tools/codex-history/project.py PRIVATE_STAGE` produces bounded user/assistant conversation projections. Raw archives preserve the omitted tool, image and instruction records.
4. `node tools/codex-history/cloud.mjs PRIVATE_STAGE upload` uploads archives through the application's resumable multipart routes. This may overlap packing. Refresh Wrangler OAuth through its official CLI first if expired.
5. `node tools/codex-history/cloud.mjs PRIVATE_STAGE verify` downloads every completed primary archive and checks all its original files. It independently reads and hashes the application's backup object. This may overlap the primary upload; it never writes upload state until that process is finished.
6. After the archive upload has stopped, `python3 tools/codex-history/bundle.py PRIVATE_STAGE` creates bounded search documents with permanent links to the uploaded raw archives. `node tools/codex-history/cloud.mjs PRIVATE_STAGE transcripts` uploads them with four bounded concurrent transfers. Search extraction and embeddings use the application's existing background jobs.
7. Place task-specific restore instructions in PRIVATE_STAGE/README.md, then run `node tools/codex-history/cloud.mjs PRIVATE_STAGE finish` to upload the manifests, verification receipt and instructions.
8. Only after cloud verification and upload completion: `python3 tools/codex-history/archive.py delete --destination PRIVATE_STAGE`. Deletion requires every primary, backup, and per-file verification proof; exact frozen selection coverage; fresh database age; closed files; and unchanged identity and contents. It retains any changed or resumed session and writes a local deletion receipt. It does not edit SQLite, repositories, worktrees, external attachments or recent logs.
9. Upload the deletion receipt and a compact local-audit.json with `node tools/codex-history/cloud.mjs PRIVATE_STAGE audit` and revoke the temporary credential with `node tools/codex-history/cloud.mjs PRIVATE_STAGE revoke`. Generated staging copies can then be removed; preserve the small audit manifests and receipts.

`restore.py` verifies an entire downloaded archive before restoring one task. Existing different/resumed files are never overwritten. It assumes this Mac's original SQLite task index remains; fresh-install database restoration is a separate operation.

Run the synthetic safety checks with `python3 -m unittest discover -s tools/codex-history -p 'test_*.py'`. Tests cover corrupted/missing verification, incomplete selection, recent/resumed/modified/open files, path traversal, bounded binary parsing, duplicate message suppression and Unicode preservation.
