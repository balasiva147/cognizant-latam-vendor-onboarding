# Cognizant LATAM Vendor Onboarding Demo

A local demonstration of a multilingual vendor-onboarding workflow for Cognizant procurement teams and LATAM vendors. The application covers ticket creation, document requests, local file uploads, procurement review, rejection feedback, versioned resubmission, notifications, and final approval.

> This repository is a demo only. Use test data and sample documents. Do not upload real vendor, financial, tax, or confidential information.

## What the demo includes

- Separate Procurement and Vendor login experiences
- LATAM country and communication-language selection
- English, Spanish, and Portuguese interface copy
- Two supported documents: **RFC Tax Certificate** and **Proof of Address**
- Unselected document checkboxes by default
- MySQL-backed vendors, tickets, workflow states, upload metadata, review history, and notifications
- Local versioned file storage under a vendor-specific directory
- Batched procurement decisions saved only after **Submit review** is selected
- A separate required rejection reason for every rejected document
- A vendor correction view showing only rejected documents and their previous rejection reasons
- Repeatable reject, resubmit, and approve cycles

## Technology and storage

- Frontend: dependency-free HTML, CSS, and JavaScript in `index.html`
- Backend: Node.js, Express, MySQL2, and Multer in `server/src/server.js`
- Database: MySQL 8
- Demo notifications: MySQL records displayed in the application's **Mail outbox**; no real email is sent
- Uploaded files: local, git-ignored `server/uploads/<vendor-id>-<sanitized-vendor-name>/originals/`

Each upload creates an immutable version record in MySQL. When procurement rejects an upload, its stored filename is marked with `rejected-vN`; a replacement upload receives the next version number. The canonical document name is not changed.

## Prerequisites

Install:

- Git
- Node.js 18 or later and npm
- MySQL Server 8 and MySQL Workbench, or another MySQL client
- Python 3 for the simple frontend web server

Check the command-line tools:

```bash
git --version
node --version
npm --version
python --version
```

On Windows, `py --version` can be used if `python` is unavailable.

## 1. Clone the repository

```bash
git clone https://github.com/balasiva147/cognizant-latam-vendor-onboarding.git
cd cognizant-latam-vendor-onboarding
```

## 2. Create the MySQL database

For a new installation:

1. Open MySQL Workbench.
2. Connect to the local MySQL server with an administrator account such as `root`.
3. Open `server/schema.sql`.
4. Run the complete script. It creates the `vendor_onboarding` database and all required tables.

Use a restricted database account instead of `root`. In a new Workbench query tab, replace every password placeholder below with the same local demo password and run:

```sql
CREATE USER IF NOT EXISTS 'vendor_app'@'localhost'
  IDENTIFIED BY 'replace_with_your_local_password';
CREATE USER IF NOT EXISTS 'vendor_app'@'127.0.0.1'
  IDENTIFIED BY 'replace_with_your_local_password';

ALTER USER 'vendor_app'@'localhost'
  IDENTIFIED BY 'replace_with_your_local_password';
ALTER USER 'vendor_app'@'127.0.0.1'
  IDENTIFIED BY 'replace_with_your_local_password';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON vendor_onboarding.* TO 'vendor_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE
  ON vendor_onboarding.* TO 'vendor_app'@'127.0.0.1';

FLUSH PRIVILEGES;
```

Confirm the schema:

```sql
USE vendor_onboarding;
SHOW TABLES;
```

Expected tables:

- `vendors`
- `onboarding_tickets`
- `ticket_documents`
- `document_uploads`
- `document_review_events`
- `vendor_notifications`

### Existing demo database

If the database was created using an older version of this repository, back it up and run `server/migrations/002_workflow_states.sql`. Do not run that migration for a fresh database; the current `server/schema.sql` already contains the latest states and notification table.

## 3. Configure the backend

From the repository root, copy the example environment file.

Windows PowerShell:

```powershell
Copy-Item server/.env.example server/.env
```

macOS or Linux:

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:

```dotenv
PORT=3000
FRONTEND_ORIGIN=http://127.0.0.1:8765
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=vendor_app
DB_PASSWORD=replace_with_your_local_password
DB_NAME=vendor_onboarding
MAX_UPLOAD_MB=15
```

`DB_PASSWORD` must exactly match the password assigned to `vendor_app`. The `.env` file and `server/uploads` directory are ignored by Git.

## 4. Install dependencies and start the API

Open terminal 1:

```bash
cd server
npm install
npm start
```

Expected startup message:

```text
Vendor onboarding API listening on http://127.0.0.1:3000
```

Open <http://127.0.0.1:3000/api/health>. A successful database connection returns:

```json
{"status":"ok","database":"connected"}
```

Keep terminal 1 running.

## 5. Start the frontend

Open terminal 2 at the repository root, not inside `server`:

```bash
python -m http.server 8765
```

On Windows, use this if needed:

```powershell
py -m http.server 8765
```

Open <http://127.0.0.1:8765>. Use this exact host and port because it matches `FRONTEND_ORIGIN` in the backend configuration.

## Demo login details

| Role | Email | Password |
| --- | --- | --- |
| Procurement | `procurement@cognizant.com` | `demo123` |
| Vendor | The vendor email entered when creating the ticket | `demo123` |
| Vendor preview | `vendor@example.com` | `demo123` |

Authentication is simulated in the browser. These are not production credentials.

## Verify the complete workflow

Use small sample `.pdf`, `.png`, `.jpg`, `.jpeg`, `.doc`, or `.docx` files. The default maximum size is 15 MB per file.

### A. Create a request as Procurement

1. Sign in as Procurement.
2. Select a LATAM country and communication language.
3. Confirm **Onboard vendor** becomes available only after both selections are made.
4. Select **Onboard vendor** and enter a unique vendor name, email, and address.
5. Confirm only **RFC Tax Certificate** and **Proof of Address** are listed.
6. Confirm neither document checkbox is selected by default.
7. Select both documents and submit.

Expected result:

- A ticket is created with status **Awaiting vendor** (`INIT` in MySQL).
- The Mail outbox contains a `DOCUMENTS_REQUESTED` notification.
- MySQL contains one vendor, one ticket, and two requested-document rows.

### B. Upload documents as the Vendor

1. Sign out.
2. Sign in as Vendor using the exact email entered on the ticket and password `demo123`.
3. Open the ticket.
4. Confirm both requested documents have upload controls.
5. Choose one sample file for each document and select **Submit uploaded documents**.

Expected result:

- Both documents show as uploaded.
- The ticket reaches **Under review** (`DOCUMENTS_UPLOADED` in MySQL).
- Files are created in `server/uploads/<vendor-id>-<sanitized-vendor-name>/originals/`.
- Initial filenames contain `-v1-`.

### C. Verify review choices are staged

1. Sign in as Procurement and open the ticket.
2. Confirm both review checkboxes are initially unselected.
3. Select both documents.
4. Choose **Approve** for RFC Tax Certificate.
5. Choose **Reject** for Proof of Address and enter a reason.
6. Before submitting, select **Close** and reopen the ticket.

Expected result: both documents are still uploaded and undecided because decisions are not stored until **Submit review** is selected.

### D. Submit a mixed approval and rejection

1. Select both documents again.
2. Approve RFC Tax Certificate.
3. Reject Proof of Address and enter a clear reason such as `Address is unreadable; upload a clearer copy.`
4. Select **Submit review**.

Expected result:

- RFC Tax Certificate becomes approved.
- Proof of Address returns to `INIT` with its rejection reason.
- The ticket displays **Changes requested**.
- A `DOCUMENTS_REJECTED` notification is added to the Mail outbox.
- The rejected stored filename contains `rejected-v1`.

### E. Verify the Vendor correction view

1. Sign in as the same Vendor or open the vendor link from the latest Mail outbox notification.
2. Open the ticket.

Expected result:

- Only the rejected Proof of Address is shown.
- The previous rejection reason is visible.
- The document name displays **Rejected (v1)**.
- A new upload control is available.

Upload a corrected Proof of Address and submit it. The new stored filename should contain `-v2-`, and the ticket should return to **Under review**.

### F. Complete onboarding

1. Sign in as Procurement.
2. Open the ticket and select the corrected Proof of Address.
3. Approve it and select **Submit review**.

Expected result:

- Both documents are approved.
- The ticket displays **Approved**.
- The database ticket and document states are `LOCAL_PROCUREMENT_ACCEPTED`.

### G. Verify separate reasons for two rejected documents

Create a second ticket, upload both documents, and reject both during one procurement review. Enter a different reason in each document's reason field and submit.

Expected result: the Vendor page shows both rejected documents, each with its own matching rejection reason and upload control.

## Verify data in MySQL

Run these read-only queries in MySQL Workbench after completing the workflow:

```sql
USE vendor_onboarding;

SELECT ticket_number, status, country_code, communication_language
FROM onboarding_tickets
ORDER BY id DESC;

SELECT d.document_name, d.status, d.rejection_reason,
       u.version_number, u.original_file_name, u.stored_file_name,
       u.storage_path, u.sha256
FROM ticket_documents d
LEFT JOIN document_uploads u ON u.ticket_document_id = d.id
ORDER BY d.id DESC, u.version_number;

SELECT decision, review_note, reviewed_by_email, reviewed_at
FROM document_review_events
ORDER BY id DESC;

SELECT notification_type, subject, delivery_status, rejected_documents
FROM vendor_notifications
ORDER BY id DESC;
```

## Workflow states

| Database state | Meaning |
| --- | --- |
| `INIT` | Vendor action is required. This covers initial requests and rejected documents awaiting correction. |
| `DOCUMENTS_UPLOADED` | Required uploads are ready for Local Procurement review. |
| `LOCAL_PROCUREMENT_ACCEPTED` | Local Procurement has approved every requested document. |

Rejection is recorded as an event in `document_review_events`. The affected document returns to `INIT`, retains its rejection reason, and can receive a new immutable upload version. This cycle continues until every requested document is accepted.

## Useful API endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Verify the API and MySQL connection |
| `POST` | `/api/tickets` | Create a vendor ticket and document request |
| `GET` | `/api/tickets` | List all tickets |
| `GET` | `/api/tickets?email=<vendor-email>` | List tickets for one vendor email |
| `GET` | `/api/tickets/<ticket-number>` | Retrieve one ticket |
| `POST` | `/api/ticket-documents/<document-id>/upload` | Upload a requested document version |
| `GET` | `/api/uploads/<upload-id>` | View an uploaded file |
| `POST` | `/api/tickets/<ticket-number>/review` | Submit one or more procurement decisions |
| `GET` | `/api/notifications?email=<vendor-email>` | List notifications for one vendor |

## Troubleshooting

### `ER_ACCESS_DENIED_ERROR` for `vendor_app`

- Confirm `DB_PASSWORD` in `server/.env` exactly matches the MySQL password.
- Confirm `DB_HOST` is `127.0.0.1` and that `vendor_app` exists for `127.0.0.1`.
- Run `SHOW GRANTS FOR 'vendor_app'@'127.0.0.1';` in Workbench.
- If the account already existed with a different password, run the `ALTER USER` and `GRANT` statements again.
- Restart the Node.js API after changing `.env`.

### Frontend reports that the backend is unavailable

- Confirm terminal 1 is still running.
- Open <http://127.0.0.1:3000/api/health>.
- Serve the frontend from `http://127.0.0.1:8765`, rather than opening `index.html` directly.
- Confirm `FRONTEND_ORIGIN=http://127.0.0.1:8765` in `server/.env`.

### Port already in use

Stop the existing process using port 3000 or 8765 before starting another server. If a different port is required, update both the environment configuration and the frontend API URL in `index.html`.

### Upload fails

- Use a supported file extension.
- Keep the file below `MAX_UPLOAD_MB`.
- Confirm the Node.js process can create files inside `server/uploads`.
- A document can receive a new upload only while it is in `INIT`.

### Review validation fails

- Select the checkbox for every document being reviewed.
- Choose either Approve or Reject for every selected document.
- Enter a separate non-empty reason for every rejected document.
- Select **Submit review** to persist the decisions.

## Repository structure

```text
.
├── index.html
├── README.md
└── server
    ├── .env.example
    ├── package.json
    ├── schema.sql
    ├── migrations
    │   └── 002_workflow_states.sql
    ├── src
    │   └── server.js
    └── uploads                 # Created locally and ignored by Git
```

## Demo limitations

- Login is simulated and is not secure authentication.
- Notifications are stored and displayed in-app; no email provider is connected.
- Files are stored on the local machine rather than object storage.
- File validation is limited to extension and size checks.
- There is no malware scanning, encryption-at-rest integration, retention automation, or production authorization model.
- RFC Tax Certificate is Mexico-specific; the same two-document list is intentionally used for every country in this focused demo.

## Development

Run the backend with automatic restart during development:

```bash
cd server
npm run dev
```

The frontend has no build step. Refresh the browser after editing `index.html`.
