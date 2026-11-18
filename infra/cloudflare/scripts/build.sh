#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
pnpm install --frozen-lockfile
pnpm --filter @papra/worker typecheck &
worker_check=$!
pnpm --filter @papra/app-client typecheck &
client_check=$!
wait "$worker_check"
wait "$client_check"
pnpm --filter @papra/worker test
pnpm --filter @papra/app-client exec vitest run
VITE_GIT_COMMIT="$(git rev-parse HEAD)" pnpm --filter @papra/app-client build
