# User Acceptance Testing Checklist

Complete in a non-production environment with representative test users for each role. Record the tester, date, environment, result, and issue reference for every check. Do not use real personal or confidential data in test fixtures.

| ID | Test | Expected result | Result / evidence |
|---|---|---|---|
| UAT-01 | Sign in with valid credentials and sign out | User lands in the application; sign out ends the browser session | |
| UAT-02 | Try to access a protected API without a token | Request is rejected; no protected record is returned | |
| UAT-03 | Administrator creates, updates, and deactivates a test user | User changes follow role rules and appear in audit history | |
| UAT-04 | ICT Officer registers an asset with valid category, tag, and purchase details | Asset is saved with generated ID and QR value | |
| UAT-05 | Register an asset with a duplicate tag or serial number | Duplicate is rejected with a clear validation message | |
| UAT-06 | Search/filter the register and view asset details | Matching records and the correct asset history are shown | |
| UAT-07 | Download the CSV template and import valid and invalid rows | Successful rows are imported; rejected rows have line numbers and reasons | |
| UAT-08 | Upload a PDF, JPEG, and PNG to a test asset | Each supported file can be listed and downloaded by permitted users | |
| UAT-09 | Request an attachment without authentication or as an unauthorized role | Request is rejected and private file content is not disclosed | |
| UAT-10 | Upload a disallowed type or content with a false file extension | Upload is rejected and no accessible attachment is created | |
| UAT-11 | Assign an asset and record acknowledgement | Custody is updated and the prior history is retained | |
| UAT-12 | Transfer an asset and complete required approval/acknowledgement | Origin and destination details remain in movement history | |
| UAT-13 | Log a fault, advance maintenance status, and complete work | Work history and costs are recorded; asset status follows workflow | |
| UAT-14 | Record a warranty and inspect expiring/expired views | Cover details and expiry alerts match the entered dates | |
| UAT-15 | Receive, issue, return, and reconcile a stock item | Balances and signed movement ledger remain consistent | |
| UAT-16 | Issue and replace a QR/barcode label and scan it | Label resolves the intended asset; prior label is retained as history | |
| UAT-17 | Create a verification exercise, record results, and complete it | Pending items block completion; exceptions are reportable | |
| UAT-18 | Request, approve, and complete a disposal | Approval/data destruction evidence is retained; asset remains historical | |
| UAT-19 | Register a licence, allocate seats, and release seats | Allocations do not exceed purchased quantity and available seats update | |
| UAT-20 | Run asset, warranty, maintenance, transfer, stock, verification, disposal, and licence reports | Report rows match source records and selected filters | |
| UAT-21 | Export a filtered report to CSV, Excel, and PDF | Each downloaded file opens and contains the expected filtered records | |
| UAT-22 | Attempt write actions with Auditor and Departmental User roles | Server rejects actions outside the role; hidden buttons are not the only control | |
| UAT-23 | Inspect audit history for a material test transaction | Actor, action, target, time, and relevant before/after values are traceable | |
| UAT-24 | Restore a recent database and attachment backup to an isolated environment | Application starts and representative records and attachments are usable | |

## Sign-off

| Role | Name | Date | Decision / outstanding issues |
|---|---|---|---|
| Business owner | | | |
| ICT system owner | | | |
| Security / audit representative | | | |

Do not approve production go-live with unresolved critical defects, untested restore procedures, default credentials, missing HTTPS, or publicly accessible attachments.
