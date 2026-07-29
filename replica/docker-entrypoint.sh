#!/bin/sh
set -eu

RAFT_REPLICAS="${RAFT_REPLICAS:-3}"
RAFT_SERVICE="${RAFT_SERVICE:-raft}"
PORT="${PORT:-5000}"
REPLICA_ID="${REPLICA_ID:-${HOSTNAME:-replica1}}"
NODE_URL="${NODE_URL:-http://${REPLICA_ID}.${RAFT_SERVICE}:${PORT}}"

if [ -z "${PEERS:-}" ]; then
  peers=""
  index=0
  while [ "$index" -lt "$RAFT_REPLICAS" ]; do
    peer_id="raft-${index}"
    if [ "$peer_id" != "$REPLICA_ID" ]; then
      peer_url="http://${peer_id}.${RAFT_SERVICE}:${PORT}"
      if [ -z "$peers" ]; then
        peers="$peer_url"
      else
        peers="${peers},${peer_url}"
      fi
    fi
    index=$((index + 1))
  done
  PEERS="$peers"
fi

export PORT REPLICA_ID NODE_URL PEERS
exec node index.js
