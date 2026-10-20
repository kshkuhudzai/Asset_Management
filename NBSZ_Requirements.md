# NBSZ ICT Asset Management System - Software Development Requirements & Scope of Work

## 1. Document Control
- **Document Title:** ICT Asset Management System - Software Development Requirements & Scope of Work
- **Version:** 1.0
- **Business Owner:** ICT Department
- **Technical Owner:** ICT Systems / Development Team
- **Intended Users:** ICT Management, ICT Officers/Technicians, Departmental Users, Auditors and System Administrators
- **System Type:** Web-based, database-driven application
- **Primary Objective:** End-to-end management of ICT assets from acquisition through assignment, maintenance, verification, transfer and disposal
- **Review:** Requirements to be reviewed and approved before development commences

## 2. Executive Summary
The organisation requires a centralised ICT Asset Management System to provide a reliable, secure and auditable record of ICT assets throughout their lifecycle. The system will replace fragmented or spreadsheet-based tracking with a controlled platform for registering, assigning, transferring, maintaining, verifying, reporting on and retiring ICT assets.
The system shall support multiple locations, departments and custodians and shall provide management dashboards, reports, audit trails, QR/barcode identification, warranty monitoring, maintenance history and asset verification capabilities. It should be designed for future integration with other organisational systems where appropriate.

## 3. Background and Business Need
ICT assets represent significant organisational resources and include end-user computing devices, servers, network equipment, communications equipment, peripherals and related technology. Effective asset management requires accurate information about ownership, location, custody, condition, warranty, maintenance, movement and disposal.
The proposed system will provide a single source of truth for ICT asset information and improve accountability, stock control, asset verification, operational reporting and management decision making.

## 4. Project Objectives
- Create a centralised and accurate register of all ICT assets.
- Track the complete lifecycle of each asset from acquisition to disposal.
- Provide clear accountability through assignment to users, departments and locations.
- Maintain a complete history of asset movements, maintenance and status changes.
- Improve physical verification and identification through QR codes or barcodes.
- Provide management dashboards and standardised reports.
- Improve monitoring of warranties, licences, repairs and asset-related obligations.
- Strengthen auditability through role-based access and audit trails.
- Provide a scalable platform that can be enhanced and integrated in future.

## 5. Scope of Work
### 5.1 User and Access Management
- Secure login and logout.
- Role-based access control.
- User creation, activation, deactivation and password management.
- Permission control by module and action where required.
- Audit trail of significant user activities.
### 5.2 Asset Registration
- Create and update asset records.
- Generate or capture unique Asset IDs and Asset Tags.
- Record serial number, make, model, category, purchase information and supplier.
- Capture location, department, custodian, condition and status.
- Use managed department and location values while retaining existing historical labels.
- Prevent duplicate asset tags and serial numbers.
- Allow attachments such as invoices, warranty documents and assignment forms.
### 5.3 Asset Assignment and Custody
- Assign assets to employees, departments and locations.
- Record assignment date and responsible officer.
- Provide acknowledgement/confirmation of receipt.
- Retain previous assignment history when an asset changes custodian.
### 5.4 Asset Transfer
- Transfer assets between users, departments and locations.
- Record transfer reason, date, initiating officer and receiving party.
- Support approval workflow where required.
- Maintain a permanent transfer history.
### 5.5 Maintenance and Repairs
- Record faults, service requests and maintenance activities.
- Record technician, vendor, repair dates, cost, parts and resolution.
- Track assets currently under repair.
- Maintain complete maintenance history.
### 5.6 Warranty and Contract Monitoring
- Record warranty provider, start date and expiry date.
- Provide upcoming-expiry alerts.
- Allow monitoring of support and maintenance contracts.
### 5.7 ICT Stock / Store
- Track assets held in ICT stores or spare stock.
- Record receipt, issue and return of stock.
- Provide stock balances and movement history.
### 5.8 QR Code / Barcode Management
- Generate or associate a unique QR/barcode with each asset.
- Support scanning for identification and verification.
- Restrict sensitive information to authenticated users.
### 5.9 Physical Verification / Stocktake
- Create verification exercises by location, department or asset category.
- Record verified, missing, damaged or incorrectly located assets.
- Support scan-based verification where feasible.
- Generate exception reports.
### 5.10 Asset Disposal and Retirement
- Record retirement and disposal decisions.
- Capture reason, approval, disposal method, date and supporting documents.
- Record data destruction confirmation for devices containing organisational information.
- Retain disposed assets in historical records.
### 5.11 Software and Licence Register
- Record software, licences, quantities, allocation and expiry.
- Track licence utilisation and renewals.
- Associate licences with users or devices where appropriate.
### 5.12 Dashboard and Reporting
- Management dashboard with key asset statistics.
- Surface overdue maintenance, upcoming warranty expiry and pending approvals as actionable reminders.
- Reports by category, location, department, custodian, status and condition.
- Warranty, maintenance, transfer, stock and disposal reports.
- Export reports to Excel and PDF where technically feasible.
### 5.13 Procurement Receiving
- Record supplier receipts with a reference, purchase order and receipt date.
- Create serialized assets in the asset register and consumables through the stock ledger.
- Preserve receipt-to-asset and receipt-to-stock-movement audit links.
- Prevent duplicate receiving when clients retry a request.

## 6. Minimum Asset Data Requirements
- **Identification:** Asset ID, Asset Tag, Asset Type, Category, Serial Number, Manufacturer, Model
- **Acquisition:** Purchase Date, Purchase Cost, Supplier, Purchase Order/Invoice Reference
- **Warranty:** Warranty Provider, Warranty Start Date, Warranty End Date, Warranty Reference
- **Location:** Branch/Location, Building/Office, Department
- **Custody:** Assigned User, Responsible Officer, Assignment Date
- **Condition:** Condition, Status, Last Inspection Date
- **Maintenance:** Last Service Date, Next Service Date, Maintenance Provider
- **Financial:** Acquisition Cost, Current/Book Value where applicable
- **Lifecycle:** Date Registered, Transfer History, Retirement Date, Disposal Date
- **Documentation:** Invoices, warranty certificates, assignment forms, transfer forms, repair reports, disposal records
- **Identification Media:** QR Code/Barcode value and printable label reference

## 7. Asset Categories
- End-user computing: desktops, laptops, tablets and workstations.
- Servers and storage: physical servers, virtualisation infrastructure and storage devices.
- Network equipment: firewalls, routers, switches, access points and related equipment.
- Communications: IP phones, mobile devices, modems and related equipment.
- Peripherals: monitors, printers, scanners, keyboards, mice, UPS devices and accessories.
- Infrastructure: racks, power equipment, CCTV and other ICT-supporting infrastructure.
- Software and licences.

## 8. Asset Lifecycle Workflow
1. Procurement / Acquisition
2. Asset Receipt
3. Asset Registration
4. Asset Tagging
5. Configuration / Preparation
6. Assignment to User / Department / Location
7. Active Use
8. Maintenance / Repair
9. Transfer / Reassignment
10. Periodic Physical Verification
11. Retirement
12. Secure Data Destruction where applicable
13. Disposal / Write-off
14. Historical Record Retention

## 9. User Roles and Access Requirements
- **System Administrator:** Full system administration, configuration, users, roles, reference data and technical settings.
- **HISO:** View all assets, approve designated workflows, dashboards, reports and management oversight.
- **ICT Officers:** Register and update assets, assign/transfer assets, maintenance, verification and operational reports.
- **Departmental User:** View assigned assets, acknowledge receipt, confirm verification and report asset issues.
- **Auditor / Reviewer:** Read-only access to approved asset records, history and reports.

## 10. Business Rules
- Every asset must have a unique Asset ID and/or Asset Tag.
- Serial numbers should be unique where the asset type has a manufacturer serial number.
- An asset must have a defined status and current location.
- An asset assigned to a user must have a recorded custodian and assignment date.
- Transfers must not erase previous ownership or location history.
- Disposed or retired assets must remain searchable as historical records.
- Material changes to asset records must be captured in the audit trail.
- Only authorised users may approve transfers, disposals or other controlled transactions.
- Sensitive information must not be exposed through unauthenticated QR-code scans.
- The system must support backup and recovery of its database and configuration.

## 11. Non-Functional and Technical Requirements
### 11.1 Application Architecture
- Web-based application accessible through the organisation's approved network environment.
- Responsive interface suitable for desktop and mobile/tablet use where feasible.
- Modular architecture that permits future enhancement and integration.
- Separation of presentation, business logic and data layers where practical.
### 11.2 Database
- Use a supported relational database such as MySQL/MariaDB or PostgreSQL, subject to ICT approval.
- Database design must maintain referential integrity.
- Use indexed fields for common searches such as Asset Tag, Serial Number and Employee.
- Provide documented backup and restore procedures.
### 11.3 Security
- Passwords must be securely hashed and never stored in plain text.
- Role-based access control must be enforced server-side.
- Input validation and protection against SQL injection and common web vulnerabilities are mandatory.
- Use secure sessions, appropriate session timeouts and account controls.
- HTTPS should be used for production deployment.
- Sensitive documents and data must be protected from unauthorised access.
- Administrative and material transactions must be auditable.
### 11.4 Performance and Availability
- Normal searches and standard pages should respond promptly under expected organisational load.
- The system should support growth in asset records without redesigning the core database.
- The system should provide clear error messages without exposing technical or database information.
- Scheduled backup should be supported and restoration should be tested periodically.

## 12. Dashboard and Reporting Requirements
- **Asset Summary:** Total assets, in use, in stock, under repair, missing, retired/disposed
- **Assets by Location:** Asset count by branch/location and category
- **Assets by Department:** Assets assigned to each department
- **Assets by Custodian:** Assets assigned to individual users
- **Condition:** Good, fair, damaged, obsolete or other configured conditions
- **Warranty:** Warranties expiring within configurable periods
- **Maintenance:** Open repairs, overdue maintenance and maintenance history
- **Transfers:** Recent and historical asset movements
- **Verification:** Verified, missing, damaged and exception assets
- **Software/Licences:** Purchased, allocated, available and expiring licences

## 13. Audit Trail and Accountability
- **Asset Created:** User, date/time, asset identifier
- **Asset Updated:** User, date/time, fields changed
- **Assignment:** From/to custodian, location, date, approving/initiating user
- **Transfer:** Old/new location and custodian, reason, date and user
- **Maintenance:** Technician, action, date, cost and outcome
- **Disposal:** Approval, method, date, user and supporting record
- **User/Role Changes:** Administrator, date/time and change made

## 14. Development Deliverables
- Approved requirements and system design.
- Database schema/data dictionary.
- Working web-based ICT Asset Management System.
- Source code under the organisation's agreed ownership/control arrangements.
- Configured user roles and permissions.
- Asset registration, assignment, transfer, maintenance, verification and disposal modules.
- QR/barcode functionality.
- Dashboard and reporting module.
- Database backup and restore procedure.
- System administrator and user documentation.
- Technical deployment/configuration documentation.
- Test plan and test results.
- User Acceptance Testing (UAT) support.
- User training and handover.
- Post-deployment defect resolution for an agreed period.

## 15. Development Phases and Milestones
1. **Requirements:** Confirm workflows, users, fields and reports -> Approved requirements and backlog
2. **Design:** Database, UI, architecture and security design -> System and database design
3. **Foundation:** Authentication, roles, reference data and asset registration -> Working core system
4. **Lifecycle:** Assignment, transfer, maintenance, warranty and stock -> Lifecycle modules
5. **Controls:** QR/barcode, verification, audit trail and disposal -> Control modules
6. **Reporting:** Dashboard, reports, exports and notifications -> Management reporting
7. **Testing:** Functional, security, performance and UAT testing -> Test evidence and defect log
8. **Deployment:** Production deployment, migration, training and handover -> Live system and documentation

## 16. Acceptance Criteria
1. All approved core modules are functional.
2. Users can register, search and retrieve asset records.
3. Duplicate asset tags and serial numbers are appropriately controlled.
4. Assets can be assigned and transferred without loss of history.
5. Maintenance and warranty information can be recorded and reported.
6. QR/barcode identification works for registered assets.
7. Physical verification can identify exceptions and produce reports.
8. Disposal and retirement records are retained historically.
9. Role-based access controls have been tested.
10. Audit trails record material system activities.
11. Dashboard and agreed management reports produce accurate information.
12. Database backup and restore have been demonstrated.
13. User Acceptance Testing has been completed and critical defects resolved.
14. Technical and user documentation has been handed over.

## 17. Data Migration
- Provide a standard Excel/CSV import template.
- Validate mandatory fields before import.
- Identify duplicates and data-quality issues.
- Provide a migration report showing successful and rejected records.
- Retain the original source register as an approved reference until migration is signed off.

## 18. Documentation, Training and Handover
- System Administrator Manual.
- End-User Guide.
- Technical Architecture / Deployment Document.
- Database/Data Dictionary.
- Backup and Restore Procedure.
- User and Role Administration Procedure.
- Asset Management Operating Procedure.
- Developer setup/deployment instructions.
- Training for ICT administrators and designated users.
- Formal handover of source code, credentials/administrative access and technical documentation.

## 19. Future Enhancements
- Integration with Microsoft 365 / Entra ID for user authentication.
- Addition of other Modules to make it an NBSZ Asset Management System covering all departments eg HCA
- Integration with helpdesk/service desk systems.
- Integration with procurement and finance systems.
- Email/Teams notifications.
- Mobile application or progressive web application.
- Automated discovery of devices on the network.
- Integration with endpoint management tools.
- Advanced analytics and asset lifecycle cost analysis.

## 20. Governance and Ownership
The ICT Department shall own the business requirements and approve the system's functional scope. The development team shall be responsible for translating the approved requirements into a secure, maintainable and documented application. Any change to the approved scope should be documented and approved through the agreed change process.

## 21. Project Constraints and Assumptions
- The organisation will provide validated asset and organisational reference data required for configuration.
- The organisation will nominate users for requirements validation and UAT.
- Hosting infrastructure, database platform and deployment arrangements will be agreed before production deployment.
- Any third-party licence or service costs will require separate approval.
- The system should avoid vendor lock-in where practical and should use documented technologies and interfaces.

## 22. Approval
This document represents the proposed baseline scope for development. The detailed requirements should be validated with ICT stakeholders before development begins. Any material changes should be documented and approved.