# NBSZ Asset Management System

## Technology and startup

- Node.js 20.13+ with Express 5, MySQL through `mysql2`, and a vanilla HTML/CSS/JavaScript frontend.
- Configure MySQL and JWT settings in `.env`; do not commit secrets.
- Run `npm install`, initialize the base schema with `node scripts/initDb.js`, and start with `npm run dev`.
- Open `http://localhost:3000`. Express serves both the frontend and `/api`.
- Run `node scripts/seedAdmin.js` to create the initial administrator if needed. The script is idempotent and does not reset an existing password.

## Modules

- Authentication, user administration, role checks, and audit trail.
- Asset register, category management, asset history, QR/barcodes, CSV import, and private document attachments.
- Assignments and custody, transfers, maintenance, warranty/contracts, and ICT stock.
- Physical verification, disposal, software licences, dashboards, and management reports.
- Reports provide filtered register and lifecycle views with CSV, Excel, and PDF export.

The database-backed integration suites live in `scripts/test*.js`; run a focused suite with `node scripts/testAssets.js` or `node scripts/testAssetImport.js`.

## Access roles

The supported roles are System Administrator, HISO, ICT Officer, Departmental User, and Auditor. Routes enforce permissions server-side. The browser UI mirrors these permissions for usability, but is not the security boundary.

## Database backup and restore

- `npm run backup:db` creates a compressed MySQL dump in `backups/` by default.
- `npm run restore:db -- "C:\\path\\to\\backup.sql.gz"` requires confirmation of the configured target database.
- Install `mysqldump` and `mysql` client utilities and add them to `PATH`, or configure `MYSQLDUMP_PATH` / `MYSQL_PATH`.
- Backups contain sensitive records. Restrict access, encrypt copies at rest, retain them outside the workspace, and regularly test restore to an isolated database.
- Back up the private `uploads/asset-documents` directory alongside the database; the database stores attachment metadata and file references.

See `README.md` for CSV import format, backup options, and local setup details. The approved functional scope is in `NBSZ_Requirements.md`.
