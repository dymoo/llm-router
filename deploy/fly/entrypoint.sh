#!/bin/bash
# Fly machine supervisor: WireGuard, Litestream, the API server and Caddy.
# If any of them exits, the machine exits non-zero and Fly restarts it.
# SIGTERM/SIGINT drain the API server first (Caddy keeps carrying its streams),
# then stop Caddy and Litestream (final sync), then WireGuard.
set -euo pipefail
data=$(dirname "$SQLITE_PATH")

# Operator hold for offline restore: `touch $data/MAINTENANCE` and restart the machine.
if [[ -e $data/MAINTENANCE ]]; then
  echo "maintenance: $data/MAINTENANCE exists; nothing started (fly ssh console to work)"
  exec sleep infinity
fi
chown node:node "$data"
as_node() { HOME=/home/node setpriv --reuid=node --regid=node --init-groups "$@"; }

# WireGuard: kernel module via wg-quick. The endpoint (DDNS) is set by the loop below, every
# minute, so a DNS failure at boot cannot keep the public API down and an IP change is followed.
umask 077
mkdir -p /etc/wireguard
cat >/etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $WG_PRIVATE_KEY
Address = $WG_ADDRESS/32
MTU = 1280

[Peer]
PublicKey = $WG_PEER_PUBLIC_KEY
AllowedIPs = $WG_ALLOWED_IPS
PersistentKeepalive = 25
EOF
umask 022
wg-quick up wg0
# A dead tunnel blackholes packets, and the router reads a Gufo probe timeout as "busy, still up".
# So every homelab address gets an unreachable fallback route, and the loop withdraws Gufo's
# tunnel route after three failed probes (about 30 s): connects then fail at once, Gufo reads
# as down and cloud-enabled keys fail over. The probe is bound to wg0, so it still sees recovery.
for ip in ${WG_ALLOWED_IPS//,/ }; do ip route add unreachable "$ip" metric 1000; done
gufo_ip=${WG_GUFO%:*}
(
  n=0 failures=0
  while true; do
    if ((n++ % 6 == 0)); then
      wg set wg0 peer "$WG_PEER_PUBLIC_KEY" endpoint "$WG_ENDPOINT" 2>/dev/null ||
        echo "wireguard: cannot resolve $WG_ENDPOINT yet" >&2
    fi
    if curl -s -m 3 --interface wg0 -o /dev/null "http://$WG_GUFO/health"; then
      ((failures >= 3)) && echo "wireguard: Gufo reachable again; restoring its route" >&2
      failures=0
      ip route replace "$gufo_ip/32" dev wg0
    elif ((++failures == 3)); then
      echo "wireguard: Gufo unreachable over the tunnel; withdrawing its route" >&2
      ip route del "$gufo_ip/32" dev wg0 2>/dev/null || true
    fi
    sleep 10
  done
) &
endpoint_loop=$!

pids=()
litestream=""
# ponytail: Litestream is skipped only before its B2 key exists (staging); production has it.
if [[ -n ${LITESTREAM_ACCESS_KEY_ID:-} ]]; then
  as_node litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$SQLITE_PATH"
  GOMEMLIMIT=32MiB as_node litestream replicate -config /etc/litestream.yml &
  litestream=$!
  pids+=("$litestream")
else
  echo "WARNING: LITESTREAM_ACCESS_KEY_ID unset; control.sqlite is NOT replicated" >&2
fi

cd /app
as_node node dist/server/main.mjs &
api=$!
pids+=("$api")
GOMEMLIMIT=32MiB as_node caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy=$!
pids+=("$caddy")

stop() {
  trap - TERM INT
  kill -TERM "$api" 2>/dev/null || true
  wait "$api" || true
  kill -TERM "$caddy" $litestream "$endpoint_loop" 2>/dev/null || true
  wait "$caddy" $litestream 2>/dev/null || true
  wg-quick down wg0 || true
  exit "${1:-0}"
}
trap stop TERM INT

wait -n "${pids[@]}" || true
echo "a supervised process exited; stopping the machine" >&2
stop 1
