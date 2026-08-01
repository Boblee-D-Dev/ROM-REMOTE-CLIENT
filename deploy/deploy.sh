#!/usr/bin/env bash
# Alias for deploy-client.sh (client only on rom-web).
exec "$(cd "$(dirname "$0")" && pwd)/deploy-client.sh" "$@"
