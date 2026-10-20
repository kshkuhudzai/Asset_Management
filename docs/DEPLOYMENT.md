# Deployment and Operations Guide

## Prerequisites

- Node.js 20.13 or later and npm; use a supported, patched Node.js LTS release for production.
- MySQL with a dedicated application database and least-privilege application account.
- HTTPS termination through the organization's approved reverse proxy or hosting platform.
- MySQL command-line client tools (`mysql` and `mysqldump`) on the operations host for backup and restore.
- A protected location for configuration secrets, database backups, logs, and private asset documents.

## Configure the application

1. Copy the source to the deployment host and install the locked dependencies with `npm ci`.
2. Create the application database and a database account scoped to that database. Grant the permissions required for normal operation and module table initialization; do not use the MySQL root account.
3. Create `.env` outside source control with:

   | Variable | Purpose |
   |---|---|
   | `DB_HOST` | MySQL hostname |
   | `DB_PORT` | MySQL port, if not the client default |
   | `DB_USER` | Application database user |
   | `DB_PASSWORD` | Application database password |
   | `DB_NAME` | Application database |
   | `JWT_SECRET` | Long, randomly generated signing secret |
   | `JWT_EXPIRES_IN` | Token lifetime accepted by `jsonwebtoken`, e.g. `8h` |
   | `NODE_ENV` | Set to `production` |
   | `PORT` | Internal Express listen port, if different from 3000 |
   | `CORS_ORIGINS` | Optional comma-separated exact origins allowed for cross-origin browser requests |
   | `TRUST_PROXY_HOPS` | Number of trusted reverse-proxy hops; defaults to `0` when the app is directly reachable |
   | `API_RATE_LIMIT_MAX` | API requests allowed per IP per window; defaults to `600` |
   | `LOGIN_RATE_LIMIT_MAX` | Failed login attempts allowed per IP per window; defaults to `10` |
   | `RATE_LIMIT_WINDOW_MS` | Rate-limit window in milliseconds; defaults to `900000` (15 minutes) |

4. Generate `JWT_SECRET` using a cryptographically secure random generator. Do not reuse the development value or commit `.env`.
5. Initialize the base schema with `node scripts/initDb.js`, then create the first administrator with `node scripts/seedAdmin.js`. Set `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_FULL_NAME` in the protected environment before seeding; use a strong unique password and do not retain default credentials.
6. Start the application with `npm start` under an approved service manager. Keep the process behind HTTPS; do not expose the internal application port directly to the public internet.

The server ensures several module tables on startup. Review logs after initial startup and ensure the database account can create the required tables and indexes.

## Network and file access

- Restrict network access to the HTTPS endpoint and MySQL to approved application/administration hosts.
- Same-origin hosting needs no CORS entry. If a separate frontend must call the API, set `CORS_ORIGINS` to its exact HTTPS origin(s), comma-separated. Unlisted origins are not granted cross-origin access.
- Keep `uploads/asset-documents` private and writable only by the application service account. It must never be mounted under the static web root or served by a public file server.
- Set restrictive filesystem permissions on `.env`, private attachments, backups, and logs. Enable disk encryption and approved malware scanning for uploaded documents.
- Configure proxy request-size limits consistent with the application limits and use HTTPS-only browser access.
- The API accepts JSON and URL-encoded request bodies up to 1 MB. API requests other than the health check are limited to 600 per client IP per 15 minutes; failed login attempts are limited to 10 per client IP per 15 minutes. The default in-memory counters are per process, so clustered deployments need a shared rate-limit store and coordinated limits.
- Keep `TRUST_PROXY_HOPS` at `0` unless requests pass through a known, fixed number of trusted proxies. Set it to that exact hop count only when the network path is controlled; an incorrect value can let clients spoof their IP and bypass rate limits or falsify audit addresses.
- The MySQL pool allows 10 active connections and queues at most 100 waiting operations; excess demand fails instead of growing an unbounded queue. Monitor those failures and size the pool against the database's connection budget.
- Do not log passwords, JWTs, database secrets, document contents, or sensitive personal data.

## Database and attachment backup

Run `npm run backup:db` with the configured database environment and MySQL client tools available. The script writes compressed dumps into `backups/` by default; set `DB_BACKUP_DIR` for a protected backup destination. Back up the private `uploads/asset-documents` directory at the same recovery point as the database. A database-only restore will leave attachment references whose files may be absent.

Encrypt backups at rest and in transit, restrict access, retain a separate off-host copy according to organizational policy, and monitor scheduled-job success. Do not rely on the workspace or developer machine as the only backup location.

## Recovery procedure

1. Declare the incident and stop application writes or take the service offline.
2. Select and verify a known-good database backup and the matching attachment backup.
3. Confirm the target database and take a separate copy of the current state when feasible.
4. Restore to a controlled target using `npm run restore:db -- "C:\\path\\to\\backup.sql.gz"`. The script asks you to type the configured database name; `--yes` bypasses this safeguard and should be restricted to controlled automation.
5. Restore the private attachment directory from the same recovery point and preserve its private permissions.
6. Verify database connectivity, login, representative assets and histories, report output, and download of a known attachment.
7. Reopen service only after the responsible owner approves recovery. Record the recovery point and any data loss.

Regularly test this procedure against an isolated database and attachment directory. The scripts do not schedule jobs, encrypt backups, create the target database, or verify backup retention.

## Release and maintenance

- Review dependency advisories and update dependencies from the lockfile through the approved change process.
- Run the relevant database-backed integration suite after a code or schema change. Run the full `node scripts/test*.js` suite before a release.
- Keep production database credentials, TLS certificates, and administrator credentials out of source control.
- Review application and reverse-proxy logs, backup-job outcomes, disk capacity, database capacity, and private upload storage.
- Test upgrades and restores using a copy before changing production.
