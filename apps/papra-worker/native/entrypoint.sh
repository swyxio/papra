#!/bin/sh
set -eu
# Cloudflare injects this ephemeral CA only when HTTPS interception is enabled.
# Local Docker verification has no interception or injected certificate.
if test -f /etc/cloudflare/certs/cloudflare-containers-ca.crt; then
  cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
fi
exec runuser -u node -- node /app/server.mjs
