# Cognizant LATAM Vendor Onboarding — Prototype

A dependency-free browser prototype for country-specific vendor onboarding across Latin America.

## Features

- Procurement and vendor login experiences
- Country and communication-language selection
- A focused two-document demo: RFC Tax Certificate and Proof of Address
- Onboarding tickets and a vendor notification outbox
- Document uploads, viewing, approval, rejection, and resubmission
- English, Spanish, and Portuguese interface copy
- Dashboard progress and status tracking

## Run locally

Complete the MySQL setup below first and make sure `server/.env` contains the `vendor_app` credentials.

In terminal 1, start the API:

```bash
cd server
npm install
npm start
```

Confirm <http://127.0.0.1:3000/api/health> returns `{"status":"ok","database":"connected"}`.

In terminal 2, from the repository root, start the frontend:

```bash
python -m http.server 8765
```

On Windows, use `py -m http.server 8765` if `python` is unavailable. Open <http://127.0.0.1:8765>. Use this exact host and port because the demo API allows that frontend origin.

## Demo accounts

- Procurement: `procurement@cognizant.com` / `demo123`
- Vendor: use the email entered on an onboarding ticket / `demo123`
- Vendor preview: `vendor@example.com` / `demo123`

## Test the complete workflow

1. Sign in as Procurement and choose a country and language.
2. Select **Onboard vendor**, enter vendor details, select the required documents, and submit. The ticket and initial alert are stored in MySQL.
3. Open **Mail outbox**, then use the vendor link, or sign out and sign in as Vendor using the same vendor email and `demo123`.
4. Open the request, choose a file for every requested document, and submit.
5. Sign back in as Procurement, open the ticket, and view each uploaded file.
6. Select each document to review, stage an approval or rejection, and enter a separate reason for every rejection. No decision is saved until **Submit review** is selected.
7. Open the vendor link from the new alert. Only rejected documents are shown, with the prior rejection reason and a new upload control.
8. Upload the corrected document and submit it.
9. Sign in as Procurement and approve the corrected version. When every document is accepted, the ticket shows **Approved** (`LOCAL_PROCUREMENT_ACCEPTED` in MySQL).

## Continue development

The frontend currently lives in `index.html`, and the API lives in `server/src/server.js`. Recommended next steps are to split the frontend into modules and integrate enterprise identity, object storage, malware scanning, audit logging, and transactional email.

## Prototype storage

- Vendors, tickets, workflow states, upload metadata, checksums, review history, and notifications: MySQL
- Uploaded file contents: local, git-ignored `server/uploads/<vendor legal name>/originals` directory
- Email delivery: represented by persistent MySQL notification records displayed in **Mail outbox**

## Demo backend and MySQL

The `server` folder contains a Node.js API and MySQL 8 schema. MySQL stores workflow data and file metadata; uploaded file bytes are kept in the local, git-ignored `server/uploads` folder.

1. In MySQL Workbench, connect to the local `MySQL80` server and run `server/schema.sql`.
2. Create the restricted `vendor_app` user using the commented example at the bottom of that file. Choose your own strong local password.
3. Copy `server/.env.example` to `server/.env` and enter the same database password.
4. Install and start the API:

   ```bash
   cd server
   npm install
   npm start
   ```

5. Verify the connection at <http://127.0.0.1:3000/api/health>.

The initial endpoints create and retrieve tickets, upload and view document versions, and approve or reject documents. Authentication and email delivery are intentionally deferred until the next iteration.

### Workflow states

| State | Meaning |
| --- | --- |
| `INIT` | Vendor action is required. New and rejected documents show an upload option. |
| `DOCUMENTS_UPLOADED` | All currently required files have been uploaded and are ready for Local Procurement review. |
| `LOCAL_PROCUREMENT_ACCEPTED` | Local Procurement has accepted every required document. |

If Local Procurement rejects a document, that document and its ticket return to `INIT`. The rejection text is retained, a `DOCUMENTS_REJECTED` notification is created for the vendor, and the next upload becomes a new immutable version. This repeats until all documents are accepted.

The canonical document name stays unchanged in MySQL. A rejected upload's stored filename is marked with `rejected-vN`, while the vendor screen displays the document as **Rejected (vN)**. This preserves an auditable document identity while making rejected versions obvious.

For a database created with the previous schema, run `server/migrations/002_workflow_states.sql` in MySQL Workbench. For a fresh database, run only `server/schema.sql` because it already contains the new states.

Local Procurement can submit several decisions together through `POST /api/tickets/:ticketNumber/review`. Vendor alerts can be read through `GET /api/vendors/:email/notifications`.

> This is a functional prototype, not a production system. Do not use real vendor documents or confidential information. Production storage must be encrypted and governed by appropriate access, retention, scanning, and audit controls.
