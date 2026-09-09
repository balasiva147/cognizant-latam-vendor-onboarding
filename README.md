# Cognizant LATAM Vendor Onboarding — Prototype

A dependency-free browser prototype for country-specific vendor onboarding across Latin America.

## Features

- Procurement and vendor login experiences
- Country and communication-language selection
- Country-specific document requirements
- Onboarding tickets and a vendor notification outbox
- Document uploads, viewing, approval, rejection, and resubmission
- English, Spanish, and Portuguese interface copy
- Dashboard progress and status tracking

## Run locally

### Option 1: Python

1. Clone the repository and enter its folder.
2. Start a local web server:

   ```bash
   python -m http.server 8765
   ```

   On Windows, use `py -m http.server 8765` if `python` is unavailable.
3. Open <http://127.0.0.1:8765>.

### Option 2: VS Code

Open the repository in VS Code, install the **Live Server** extension, right-click `index.html`, and choose **Open with Live Server**.

The page can also be opened directly, but a local server provides more consistent browser-storage and document-preview behavior.

## Demo accounts

- Procurement: `procurement@cognizant.com` / `demo123`
- Vendor: use the email entered on an onboarding ticket / `demo123`
- Vendor preview: `vendor@example.com` / `demo123`

## Continue development

The UI, styling, data, and workflow logic currently live in `index.html`. Recommended next steps are to split it into modules, add a backend API and database, and integrate enterprise identity, secure object storage, malware scanning, audit logging, and transactional email.

## Prototype storage

- Workflow and ticket metadata: browser `localStorage`
- Uploaded document contents: browser `IndexedDB`
- Email alerts: simulated in the in-app **Mail outbox**, including a working vendor-access link

Browser data is isolated by origin. To retain the same test data between sessions, run the app on the same host and port. Clearing browser site data resets the prototype.

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

For a database created with the previous schema, run `server/migrations/002_workflow_states.sql` in MySQL Workbench. For a fresh database, run only `server/schema.sql` because it already contains the new states.

Local Procurement can submit several decisions together through `POST /api/tickets/:ticketNumber/review`. Vendor alerts can be read through `GET /api/vendors/:email/notifications`.

> This is a functional prototype, not a production system. Do not use real vendor documents or confidential information. Production storage must be encrypted and governed by appropriate access, retention, scanning, and audit controls.
