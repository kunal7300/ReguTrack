# Production deployment

Use a Linux host with Docker Engine, the Docker Compose plugin, and a DNS name pointing to that host. Allow inbound TCP 80 and 443. Caddy serves the built React assets and proxies the API through the same HTTPS origin. The API, database, Redis, object storage, and AI service have no published host ports. Caddy reaches the API on a separate network from the data services.

1. Create a private `.env.production` from `.env.example` with fresh random credentials for `POSTGRES_PASSWORD`, `REGUTRACK_DB_APP_PASSWORD`, `JWT_SECRET`, `PDF_SERVICE_TOKEN`, and `S3_SECRET_KEY`. Use a 64-character hexadecimal JWT signing key. The deployment overlay enforces secure refresh cookies.
2. Set `PUBLIC_DOMAIN` to the DNS name and `PUBLIC_ORIGIN` to its exact HTTPS origin. Set a Gemini key if approved content can be sent to the provider.
3. Run the following on the deployment host.

```bash
chmod 600 .env.production
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml up --build --wait
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml ps --all
curl --fail --silent https://your-host.example/api/health/ready
```

The migration container must exit with code 0. The readiness endpoint checks PostgreSQL, Redis, the AI service, and object storage. Create the first administrator with the [administrator bootstrap command](../PROJECT_GUIDE.md#create-the-first-super-admin), using the same Compose files and environment file.

For managed services, provide a site-specific Compose override and configure independent migration-owner and application connections. Set the API's `PG_TLS=true` and `PGPORT` as needed, use a verified `rediss://` URL, and give the application role the grants in the migration files. Configure HTTPS object storage with access restricted to the regulatory and evidence buckets. Provision both buckets before starting the API when its service account lacks bucket creation rights.

The API logs request IDs, status codes, methods, and durations as JSON. Logs omit request bodies, URLs, tokens, and credentials. Shared Redis limits protect login, refresh, expensive processing, and other API writes. The production profile validates browser origins for writes and exposes one HTTPS origin.

## Back up and restore

Choose a protected backup destination outside the repository. Run the supplied Linux backup script from the repository root. It pauses API and object storage writes while snapshotting PostgreSQL and the RustFS data volume, then restarts the services. Schedule it through your deployment platform during an approved maintenance window.

```bash
bash deploy/backup.sh /secure/backups/regutrack-YYYYMMDD --env-file .env.production -f compose.yaml -f compose.production.yaml
```

Keep secrets separately and encrypt backup storage. On a separate restore host, verify both files with `sha256sum -c SHA256SUMS`. Restore the custom-format PostgreSQL dump into an empty database as the migration owner with `pg_restore --exit-on-error --no-owner --no-acl`. Use a fresh RustFS volume and extract `objects.tgz` at its root while RustFS is stopped, preserving numeric ownership. Run migrations to reapply runtime grants before starting the API. Verify readiness, then check an archived task, its evidence checksum and decision, and its source citation.
