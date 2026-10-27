#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$MONGO_REPLICA_KEY" > /tmp/mongo-replica.key
chmod 400 /tmp/mongo-replica.key
chown mongodb:mongodb /tmp/mongo-replica.key
exec /usr/local/bin/docker-entrypoint.sh mongod --bind_ip_all --replSet rs0 --keyFile /tmp/mongo-replica.key
