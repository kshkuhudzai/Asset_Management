# NBSZ Asset Management System

Web-based ICT asset register built with Node.js, Express, MySQL, and vanilla JavaScript.

## Run locally

1. Install Node.js 20.13+ and MySQL.
2. Create the database and configure the connection and JWT settings in `.env`.
3. Install dependencies with `npm install`.
4. Initialize the database with `node scripts/initDb.js`.
5. Start the application with `npm run dev` and open `http://localhost:3000`.

The application serves the frontend and API from the same Express server. Run `node scripts/seedAdmin.js` after database initialization to create the initial System Administrator. Set `ADMIN_PASSWORD` to a strong temporary password before seeding in production; production seeding fails if it is missing or too weak, and the password is never printed to logs. The account must change its password at first login. System Administrators can create and manage other accounts from **User Accounts**; new accounts and admin password resets can require a first-login password change.

`node scripts/seedDemoData.js` is for non-production environments only; it is blocked when `NODE_ENV=production`.

Browser sessions use an HttpOnly, SameSite cookie and unsafe cookie-authenticated requests are restricted to the same origin. Do not persist session tokens in browser storage.

Passwords must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character. Password creation, reset, and change forms show a live checklist; the server enforces the same policy.

The interface uses the red-and-white palette from the user-provided NBSZ logo image. Colors were sampled approximately from that image, not from an official brand guide.

Asset disposal must use the request, independent approval, and completion workflow. Direct asset deletion and direct status changes to `Disposed` are rejected.

Transfers recorded as `Pending` do not change the asset register or custody history until an independent System Administrator or HISO approves them. Approval applies the custody changes in a database transaction; if the asset's custody changed while approval was pending, approval is rejected and the request must be reviewed again. Cancelling a pending transfer leaves custody unchanged. `Completed` transfers continue to apply immediately.

## Operational workflows

System Administrators and HISO manage canonical departments and locations from **Departments & Locations**. Existing asset values are seeded into these lists; values can be deactivated without deleting them, and existing records retain their original names.

The dashboard highlights overdue maintenance and warranties expiring in the next 30 days. System Administrators and HISO also see pending transfer and disposal approval counts, with links to the workflows.

The **Procurement Receiving** view groups a goods receipt into one audited transaction. Serialized lines create normal assets in **In Stock**; consumable lines create or update store cards and append stock receipt movements. Each request requires an idempotency key or unique receipt reference so retries do not double-receive goods. Receiving is available to System Administrators, HISO, and ICT Officers; auditors can view receipts.

The QR / barcode scanner offers a camera option in browsers that implement `BarcodeDetector` and `getUserMedia`. Camera access requires a secure browser context (HTTPS, or localhost); manual scanning remains available when camera scanning is unsupported or denied.

## Reports and exports

The Reports view supports filtered CSV, Excel (`.xlsx`), and PDF downloads. The spreadsheet and PDF exports use the same server-side report query and filters as the on-screen results. Access is restricted to System Administrators, HISO, ICT Officers, and Auditors.

## Import assets from CSV

Users with asset-write permissions can open **Asset Register → Import CSV** and download the current template. The importer accepts up to 1,000 rows and 2 MB per file. It reports each imported or rejected row; successful rows are audited like assets registered through the form.

The template uses these snake_case column names:

`asset_id, asset_tag, serial_number, category_name, manufacturer, model, purchase_date, purchase_cost, supplier, po_invoice_ref, warranty_provider, warranty_start, warranty_end, warranty_ref, location, department, assigned_user_id, responsible_officer, status, condition_status, last_inspection_date`

Only `asset_tag` is required. Dates use `YYYY-MM-DD`; category names must already exist. Leave `asset_id` blank to generate one. Import rows are processed independently, so rejected rows do not roll back successful rows. Duplicate IDs, tags, and serial numbers are reported as rejected rows.

## Asset documents

Administrators, HISO, and ICT Officers can attach PDF, JPEG, or PNG documents (up to 10 MB) to an asset from its detail view. Documents are stored outside the public web root, checked against their file signatures, and served only through authenticated, role-protected download routes. Auditors may view and download; only asset writers may upload or delete. Back up the private `uploads/asset-documents` directory together with the database, since the database stores document metadata and references to those files.

## Integration tests

Run the security middleware checks with `npm run test:security` and focused suites with `node scripts/testAssetImport.js`, `node scripts/testReferenceData.js`, and `node scripts/testProcurement.js`. The database-backed suites in `scripts/test*.js` cover the system modules and clean up their test fixtures when they complete.

## Database backup and restore

Install the MySQL client tools (`mysqldump` and `mysql`) and add them to `PATH`, or set `MYSQLDUMP_PATH` and `MYSQL_PATH` in the environment. The scripts read `DB_HOST`, `DB_PORT` (optional), `DB_USER`, `DB_PASSWORD`, and `DB_NAME` from `.env`; passwords are passed through the child process environment, not command-line arguments.

Create a compressed, transaction-consistent backup with `npm run backup:db`. Backups go to `backups/` by default; set `DB_BACKUP_DIR` or pass a directory as the first script argument to select another location. Keep backups encrypted and access-controlled outside the application workspace as well; database dumps can contain user and asset information.

Restore with `npm run restore:db -- "C:\path\to\backup.sql.gz"`. The script requires you to type the configured database name before proceeding. `--yes` skips that prompt and should only be used in an explicitly controlled automation. Restore replaces tables and data represented in the dump; stop application writes first, confirm the target database, and verify the restored data before reopening service. Keep a separate known-good backup before restoring.

Test backups by restoring them to an isolated database, not over the live database. These scripts require an existing target database and the MySQL tools; the project cannot verify operational backup retention or recovery without that deployment setup.

## Handover and acceptance

- `docs/USER_GUIDE.md` explains role-based day-to-day workflows.
- `docs/DEPLOYMENT.md` covers production configuration, attachment storage, backups, and recovery.
- `docs/UAT_CHECKLIST.md` provides acceptance scenarios and sign-off records.