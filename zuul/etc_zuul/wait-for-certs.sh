#!/bin/bash
# Wait for Zuul ZooKeeper client certs to exist before starting a service
# that depends on them.
set -e

CERT_FILE="${1:-/var/certs/keystores/zk.pem}"

for i in $(seq 1 300); do
  [ -f "$CERT_FILE" ] && exit 0
  sleep 1
done

echo "Timeout waiting for $CERT_FILE" >&2
exit 1
