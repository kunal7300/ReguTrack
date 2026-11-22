#!/usr/bin/env bash
set -euo pipefail
if (( $# < 1 )); then
  echo 'Usage: bash deploy/backup.sh <new-directory> [compose options]' >&2
  exit 2
fi
destination=$1
shift
compose=(docker compose "$@")
umask 077
mkdir -- "$destination"
destination=$(cd -- "$destination" && pwd)
objects=$("${compose[@]}" ps -q objects)
[ -n "$objects" ] || { echo 'Object service must be running before backup' >&2; exit 1; }
volume=$(docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/data") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$objects")
[[ "$volume" =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo 'RustFS data volume was not found' >&2; exit 1; }
image=$("${compose[@]}" images -q postgres)
[ -n "$image" ] || { echo 'PostgreSQL image was not found' >&2; exit 1; }
resume() {
  status=$?
  trap - EXIT
  "${compose[@]}" up -d --wait objects api web >&2 || exit 1
  exit "$status"
}
trap resume EXIT
"${compose[@]}" stop web api objects >&2
"${compose[@]}" exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$destination/postgres.dump"
docker run --rm --network none --mount "type=volume,source=$volume,target=/snapshot,readonly" --entrypoint tar "$image" -C /snapshot -czf - . > "$destination/objects.tgz"
(cd -- "$destination" && sha256sum postgres.dump objects.tgz > SHA256SUMS)
echo 'Database and object snapshots written. Verify SHA256SUMS before restoring.'
