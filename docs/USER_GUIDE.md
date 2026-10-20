# NBSZ Asset Management System — User Guide

## Sign in and permissions

Open the application URL provided by your administrator and sign in with your assigned username and password. Use **Sign out** when finished, especially on a shared computer. Change a temporary password from your profile as soon as your administrator instructs you to do so.

The system supports System Administrator, HISO, ICT Officer, Departmental User, and Auditor roles. Screens and actions vary by role; the server enforces permissions even if a user tries to call an action directly.

| Role | Typical access |
|---|---|
| System Administrator | User administration, configuration, operational asset work, approvals, and reports |
| HISO | Oversight, approvals, operational work, and reports |
| ICT Officer | Asset and lifecycle operations, document handling, verification, licences, and reports |
| Departmental User | Consult the register and use actions specifically assigned to the role |
| Auditor | Read-only oversight, records, histories, documents, and reports |

Your administrator determines the access appropriate to your duties.

## Asset Register

Choose **Asset Register** to search and filter assets. Open an asset using **View** to see its identification, category, status, condition, custody, purchase and warranty information, maintenance history, movement history, and attached documents.

Users with asset-write permission can select **Register asset**. The physical asset tag is required; other fields can be completed when information is available. Asset IDs and QR values are generated when omitted. System Administrators and HISO maintain department and location choices in **Departments & Locations**. Existing names are retained when a value is deactivated.

### Import assets from CSV

1. Choose **Import CSV**, then download the template.
2. Fill in the supported snake_case columns. `asset_tag` is required; dates must use `YYYY-MM-DD`, and category names must already exist.
3. Save as CSV and upload a file no larger than 2 MB. A file can contain at most 1,000 asset rows.
4. Review the migration report. Each successful row is registered and audited separately; rejected rows include row numbers and reasons.

Do not import passwords, software product keys, or unrelated personal information. Back up the database before a large migration.

### Asset documents

From an asset's detail view, authorized staff can upload a PDF, JPEG, or PNG document up to 10 MB. Use clear filenames such as an invoice or service report reference. Auditors and authorized staff can download the attached documents; asset writers can delete them. Do not upload unrelated, executable, password, or unapproved sensitive files.

## Custody and lifecycle

- **Assignments:** Record who receives an asset and its custody details. Follow the application acknowledgement workflow so receipt is recorded.
- **Transfers:** Record the destination custodian, department or location, date, and reason. Complete any approval and receiving-party acknowledgement shown by the workflow.
- **Maintenance:** Log faults or scheduled work, update progress, and record technician/vendor, work performed, outcome, dates, and cost when known. Keep the maintenance record as the service history.
- **Warranty & Contracts:** Record cover and provider information. Review the expiring and expired views regularly.
- **Procurement Receiving:** Record the delivery reference, supplier, purchase order, and received items. Choose serialized assets to add them to the register as **In Stock**, or consumables to create/update a store card and append its receipt movement. Use the same receipt reference and receipt details when retrying an uncertain submission.
- **ICT Stock:** Use receipt, issue, return, and adjustment transactions to keep balances and the movement ledger accurate. Do not bypass the ledger to represent a normal issue or return.
- **QR / Barcodes:** Issue labels from the label register or asset coverage view. Scan or enter a code to identify an asset. On a compatible browser, **Use camera** scans supported QR/barcode formats; camera access requires HTTPS or localhost. Replace damaged or lost labels through the replacement workflow so the old label is retained in history.
- **Verification:** Create an exercise with the applicable department, location, or category scope. Record each asset's actual verification result and location; resolve pending items before completing the exercise. Review the exception report.
- **Disposal:** Submit a request with reason, method, date, and final condition. Authorized approvers review it. Complete only after the required approval and data-destruction evidence are recorded. Disposed assets remain in the historical register.
- **Software Licences:** Record the entitlement and purchased seat count. Allocate seats to the appropriate user or device and release them when no longer in use. Product keys are deliberately not stored by this system.

The **Dashboard** highlights overdue work, warranties expiring within 30 days, and pending transfer/disposal approvals visible to authorized approvers. Select a reminder to open the relevant workflow.

## Reports and exports

Choose **Reports**, select a report, apply available filters, and select **Run report**. Available reports cover the asset register, warranty expiry, maintenance, transfers, stock balances and movements, verification exceptions, disposal, and software licence entitlements.

Use **CSV**, **Excel**, or **PDF** to download the filtered result. Reports are limited to 5,000 rows; refine filters if the screen says the result was truncated. Treat exported files as organizational records: store them only in approved, access-controlled locations.

## Data quality and support

Use the same names for departments and locations; avoid creating near-duplicates such as abbreviations and spelling variations. Record changes promptly, provide reasons where requested, and use the workflow rather than overwriting history.

If a record, attachment, or action appears incorrect, stop before repeating an irreversible action and contact the system administrator. Provide the asset ID, the screen/action, approximate time, and the message shown. Never send passwords or authentication tokens in a support request.
