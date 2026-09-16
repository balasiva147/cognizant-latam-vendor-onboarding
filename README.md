# Cognizant LATAM Vendor Onboarding Demo

A local demonstration of a multilingual vendor-onboarding workflow for Cognizant procurement teams and LATAM vendors. The application covers ticket creation, document requests, local file uploads, procurement review, rejection feedback, versioned resubmission, notifications, and final approval.

> This repository is a demo only. Use test data and sample documents. Do not upload real vendor, financial, tax, or confidential information.

## What the demo includes

- Supabase email/password login, email verification, registration, and password reset
- Backend-enforced Local SOA, Indian SOA, Corporate Security, and vendor access
- LATAM country and vendor communication-language selection
- English-only site interface; communication language does not translate the UI
- Vendor legal name, owner/authorized-person name, email, and registered-address collection
- Two supported documents: **RFC Tax Certificate** and **Proof of Address**
- Country-specific document lists: some demo countries require one supported document and others expose both
- Unselected document checkboxes by default
- MySQL-backed vendors, tickets, workflow states, upload metadata, review history, and notifications
- Local versioned file storage under a vendor-specific directory
- Batched procurement decisions saved only after **Submit review** is selected
- A separate required rejection reason for every rejected document
- A vendor view showing only pending requested/rejected documents and correction reasons; internal workflow and review history are not shown to vendors
- Repeatable reject, resubmit, and approve cycles
- Automatic local LibreTranslate translation to English after every requested document is approved
- Local extraction of text-based PDFs and generation of separate English review PDFs
- Indian SOA review after all latest translations complete, followed by Corporate Security
- Indian SOA owns vendor document requests; every human workflow handoff sends an email to the next responsible party
- Indian SOA and Corporate Security rejections go directly to the vendor with separate reasons
- Per-request flow dashboard with green completed steps, current stage, and upload/review history

## Technology and storage

- Frontend: dependency-free `index.html`, `auth-ui.js`, and `workflow-ui.js`
- Backend: Node.js, Express, MySQL2, Multer, pdf-parse, and PDFKit
- Database: MySQL 8
- Real Gmail SMTP notifications, with PENDING/SENT/FAILED status and manual retry in Mail outbox
- Uploaded originals: local, git-ignored `server/uploads/<vendor-id>-<sanitized-vendor-name>/originals/`
- English translations: local, git-ignored `server/uploads/<vendor-id>-<sanitized-vendor-name>/translated/`

Each upload creates an immutable version record in MySQL. When procurement rejects an upload, its stored filename is marked with `rejected-vN`; a replacement upload receives the next version number. The canonical document name is not changed.

## Prerequisites

Install:

- Git
- Node.js 18 or later and npm
- MySQL Server 8 and MySQL Workbench, or another MySQL client
- Node.js for the restricted frontend web server
- LibreTranslate running locally (Python installation or Docker)

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
- `document_translations`
- `workflow_events`

### Existing demo database

If the database was created using an older version of this repository, back it up and run the applicable migrations in order:

1. `server/migrations/002_workflow_states.sql`
2. `server/migrations/003_document_translations.sql`
3. `server/migrations/004_libretranslate_defaults.sql`
4. `server/migrations/005_vendor_authorized_person.sql`
5. `server/migrations/006_downstream_reviews.sql` (run once as root; preserves existing requests)

For a fresh database, run only `server/schema.sql`; it already includes all current tables.

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
MAX_UPLOAD_MB=10
LIBRETRANSLATE_URL=http://127.0.0.1:5000
LIBRETRANSLATE_TARGET_LANGUAGE=en
LIBRETRANSLATE_CHUNK_CHARACTERS=4000
LIBRETRANSLATE_TIMEOUT_MS=120000
LIBRETRANSLATE_API_KEY=
```

`DB_PASSWORD` must exactly match the password assigned to `vendor_app`. The `.env` file and `server/uploads` directory are ignored by Git.

The local LibreTranslate server does not require an API key by default, so leave `LIBRETRANSLATE_API_KEY` blank. Never put credentials in `index.html` or commit `server/.env`.

## 4. Start LibreTranslate locally

LibreTranslate is a separate local service. Keep it running while testing translations.

### Option A: Python virtual environment on Windows

Use Python 3.11 and a short installation path. A short path avoids Windows' legacy path-length limit when installing the machine-learning libraries:

```powershell
$ltInstallRoot = Join-Path $env:LOCALAPPDATA 'LibreTranslateDemo'
py -3.11 -m venv "$ltInstallRoot\venv"
& "$ltInstallRoot\venv\Scripts\python.exe" -m pip install --upgrade pip
& "$ltInstallRoot\venv\Scripts\python.exe" -m pip install libretranslate
$env:XDG_DATA_HOME = "$ltInstallRoot\data"
$env:XDG_CONFIG_HOME = "$ltInstallRoot\config"
$env:XDG_CACHE_HOME = "$ltInstallRoot\cache"
& "$ltInstallRoot\venv\Scripts\libretranslate.exe" --load-only en,es,pt,pt-BR --host 127.0.0.1 --port 5000 --disable-web-ui --disable-files-translation
```

The first installation and first start can take several minutes because Python packages and translation models are downloaded. Later translations run locally. Keep this terminal open.

If a corporate proxy permits `argos-net.com` but blocks the Argos model index, download and install the three official packages directly before starting LibreTranslate:

```powershell
$ltModelFolder = "$ltInstallRoot\models"
New-Item -ItemType Directory -Force -Path $ltModelFolder | Out-Null
Invoke-WebRequest 'https://argos-net.com/v1/translate-es_en-1_9.argosmodel' -OutFile "$ltModelFolder\translate-es_en-1_9.argosmodel"
Invoke-WebRequest 'https://argos-net.com/v1/translate-pt_en-1_9.argosmodel' -OutFile "$ltModelFolder\translate-pt_en-1_9.argosmodel"
Invoke-WebRequest 'https://argos-net.com/v1/translate-pb_en-1_9.argosmodel' -OutFile "$ltModelFolder\translate-pb_en-1_9.argosmodel"
& "$ltInstallRoot\venv\Scripts\python.exe" -c "from argostranslate import package; import glob; [package.install_from_path(p) for p in glob.glob(r'$ltModelFolder\*.argosmodel')]; print('Models installed')"
```

### Option B: Docker Desktop

If Docker Desktop is already installed and running:

```powershell
docker run --rm -it -p 5000:5000 libretranslate/libretranslate --load-only en,es,pt,pt-BR
```

Verify the local service in a new PowerShell window:

```powershell
$body = @{ q = 'Certificado fiscal'; source = 'es'; target = 'en'; format = 'text' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5000/translate -ContentType application/json -Body $body
```

The response should contain English text in `translatedText`. The backend explicitly uses Spanish for Spanish-language tickets and Brazilian Portuguese for Brazil/Portuguese tickets rather than relying only on automatic detection.

## 5. Install dependencies and start the API

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

## 6. Start the frontend

Open terminal 2 at the repository root, not inside `server`:

```bash
python -m http.server 8765
```

On Windows, use this if needed:

```powershell
py -m http.server 8765
```

Open <http://127.0.0.1:8765>. Use this exact host and port because it matches `FRONTEND_ORIGIN` in the backend configuration.

## Real login and email configuration

Keep existing MySQL and LibreTranslate settings in `server/.env`, and add:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_publishable_key
PROCUREMENT_ADMIN_EMAIL=your_procurement@gmail.com
APP_BASE_URL=http://127.0.0.1:8765/
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_sender@gmail.com
SMTP_PASS=your_16_character_google_app_password
SMTP_FROM="LATAM Vendor Onboarding Demo <your_sender@gmail.com>"
```

No Supabase secret/admin key is required by this implementation. Never commit credentials.
Enable Email and Confirm email in Supabase. Set Site URL and allowed Redirect URL to
`http://127.0.0.1:8765/`. Configure Gmail custom SMTP there too: Supabase sends confirmation
and password-reset emails; the Node backend sends document requests and rejections.

Register the designated procurement email using **Create account**, choose a new password,
confirm the email, then sign in. No other email can self-assign procurement access.
Vendors register using an email already present on a procurement-created ticket. The invitation
prefills their email but grants no access itself: Supabase verification and login are required.
Confirmation and reset links use Supabase's expiry and single-use verification behavior.
Registration for an existing account does not overwrite its password; use **Forgot password?**.

The backend verifies Supabase identity on requests and uses HttpOnly session cookies.
Sessions expire after eight hours and are lost on backend restart. Use the exact same
127.0.0.1 host for both services. Remote devices cannot use these localhost invitation links.
Do not run Python's repository-wide file server: use `node start-frontend.js` to prevent
access to private configuration and uploaded documents.

No new MySQL migration is needed for authentication: Supabase stores account credentials,
and vendor ownership is matched to the verified email. Existing vendors can register with
their recorded email. Existing notification rows are not automatically mailed. Only new
requests/rejections are sent, or Indian SOA can explicitly retry a pending/failed vendor email.
SENT means the SMTP server accepted the message, not proof of inbox delivery.
Failed/pending deliveries require manual retry, including after an interrupted backend.

## Verify the complete workflow

Use small sample `.pdf`, `.png`, `.jpg`, `.jpeg`, `.doc`, or `.docx` files. The default maximum size is 15 MB per file.

### A. Create a request as Indian SOA

1. Sign in with the verified Indian SOA account.
2. Select a LATAM country and vendor communication language. Confirm the interface remains in English.
3. Confirm **Onboard vendor** becomes available only after both selections are made.
4. Select **Onboard vendor** and enter vendor legal name, owner/authorized person, email, and address.
5. Confirm only **RFC Tax Certificate** and **Proof of Address** are listed.
6. Confirm neither document checkbox is selected by default.
7. Select the country-specific documents and choose **Send request**.

Expected result:

- A ticket is created with status **Awaiting vendor** (`INIT` in MySQL).
- The Mail outbox contains a `DOCUMENTS_REQUESTED` notification.
- MySQL contains one vendor, one ticket, and two requested-document rows.

### B. Upload documents as the Vendor

1. Sign out.
2. Open the actual request email, register with the invited address, confirm the verification email, then sign in with your chosen password.
3. Open the ticket.
4. Confirm both requested documents have upload controls.
5. Choose one sample file for each document and select **Submit uploaded documents**.

Expected result:

- Both documents show as uploaded.
- The ticket reaches **Under review** (`DOCUMENTS_UPLOADED` in MySQL).
- Local SOA receives an email that the request is ready for review.
- Files are created in `server/uploads/<vendor-id>-<sanitized-vendor-name>/originals/`.
- Initial filenames contain `-v1-`.

### C. Verify review choices are staged

1. Sign in as Local SOA and open the ticket.
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

1. Sign in as the same Vendor or follow the link in the actual rejection email.
2. Open the ticket.

Expected result:

- Only the rejected Proof of Address is shown.
- The previous rejection reason is visible.
- The document name displays **Rejected (v1)**.
- A new upload control is available.

Upload a corrected Proof of Address and submit it. The new stored filename should contain `-v2-`, and the ticket should return to **Under review**.

### F. Complete onboarding

1. Sign in as Local SOA.
2. Open the ticket and select the corrected Proof of Address.
3. Approve it and select **Submit review**.

Expected result:

- Both documents are approved.
- The request moves to translation and then Indian SOA. It displays **Approved** only after Corporate Security approves all documents; continue with the downstream verification section below.
- The database ticket and document states are `LOCAL_PROCUREMENT_ACCEPTED`.
- Two background translation records progress through `PENDING`, `PROCESSING`, and `COMPLETED`.
- English files are written under `server/uploads/<vendor-id>-<sanitized-vendor-name>/translated/`.
- Translated filenames contain `translated-en-vN` and can be retrieved through the translation download endpoint.
- Reopening the Local SOA ticket shows the translation status and a **View English** button after completion.

Translation runs after the approval transaction commits, so a temporary LibreTranslate failure does not undo procurement approval. A failed request is recorded as `FAILED` with diagnostic text in `document_translations`. The generated English PDF is a readable review copy; it does not reproduce the original form layout.

### G. Verify separate reasons for two rejected documents

Create a second ticket, upload both documents, and reject both during one Local SOA review. Enter a different reason in each document's reason field and submit.

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

SELECT target_language, provider, status, translated_file_name,
       storage_path, billed_characters, last_error, completed_at
FROM document_translations
ORDER BY id DESC;
```

## Workflow states

| Database state | Meaning |
| --- | --- |
| `INIT` | Vendor action is required. This covers initial requests and rejected documents awaiting correction. |
| `DOCUMENTS_UPLOADED` | Required uploads are ready for Local SOA review. |
| `LOCAL_PROCUREMENT_ACCEPTED` | Local SOA has approved every requested document. |

Rejection is recorded as an event in `document_review_events`. The affected document returns to `INIT`, retains its rejection reason, and can receive a new immutable upload version. This cycle continues until every requested document is accepted.

## Useful API endpoints

Except health and authentication entry points, all endpoints require a valid session cookie.
POST requests also require the configured frontend Origin. Vendor list filters are enforced by
verified identity; changing the email query parameter cannot expose other vendors.
Procurement-only routes include ticket creation, review, translation retry, and email retry.


| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Verify the API and MySQL connection |
| `POST` | `/api/tickets` | Create a vendor ticket and document request |
| `GET` | `/api/tickets` | List all tickets |
| `GET` | `/api/tickets?email=<vendor-email>` | List tickets for one vendor email |
| `GET` | `/api/tickets/<ticket-number>` | Retrieve one ticket |
| `POST` | `/api/ticket-documents/<document-id>/upload` | Upload a requested document version |
| `GET` | `/api/uploads/<upload-id>` | View an uploaded file |
| `GET` | `/api/translations/<translation-id>` | View a completed English translation |
| `POST` | `/api/tickets/<ticket-number>/translations/retry` | Retry failed translations for an approved ticket |
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

### Local translation fails

- Confirm LibreTranslate is still running and open <http://127.0.0.1:5000/languages>.
- Confirm `LIBRETRANSLATE_URL=http://127.0.0.1:5000` in `server/.env`.
- Check `document_translations.last_error` for the exact failure.
- The demo translation pipeline supports text-based PDF uploads. Image-only/scanned PDFs report that OCR is required.
- Restart the Node.js API after changing environment configuration.
- To reprocess an already failed approved ticket, replace the ticket number and run:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/tickets/LAT-2026-0000/translations/retry
```

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
    │   ├── 002_workflow_states.sql
    │   ├── 003_document_translations.sql
    │   ├── 004_libretranslate_defaults.sql
    │   └── 005_vendor_authorized_person.sql
    ├── src
    │   ├── server.js
    │   └── translation.js
    └── uploads                 # Created locally and ignored by Git
        └── <vendor-id>-<vendor-name>
            ├── originals
            └── translated
```

## Demo limitations

- Sessions are in memory for a single local backend and end on restart.
- Gmail and Supabase delivery limits apply. Use Mail outbox to retry failed notifications.
- Files are stored on the local machine rather than object storage.
- File validation is limited to extension and size checks.
- There is no malware scanning, encryption-at-rest integration, retention automation, or production authorization model.
- Country document lists are simplified for the demo and are not a substitute for current local legal or tax requirements.

## Development

Run the backend with automatic restart during development:

```bash
cd server
npm run dev
```

The frontend has no build step. Refresh the browser after editing `index.html`.

## Indian SOA and Corporate Security workflow

### Upgrade and team accounts

1. Back up the demo database. Stop the backend and run `server/migrations/006_downstream_reviews.sql` once in MySQL Workbench as root. Do not rerun older migrations on an up-to-date database. A fresh installation needs only `server/schema.sql`.
2. Save three **distinct** team email addresses in `server/.env`:
   ```dotenv
   PROCUREMENT_ADMIN_EMAIL=local-team@example.com
   INDIA_PROCUREMENT_EMAIL=india-team@example.com
   CORPORATE_SECURITY_EMAIL=security-team@example.com
   ```
   These are placeholders. Use your test addresses and a different vendor address. Roles come only from these backend settings, not from browser input. Never commit `.env`.
3. Restart **both** Node processes: backend (`node --use-system-ca src/server.js` from `server`) and frontend (`node start-frontend.js` from the repository root). The frontend allowlist now includes `workflow-ui.js`. Keep MySQL and LibreTranslate running. Press Ctrl+F5.
4. Each team opens **Create account**, registers with its configured email, follows its verification email, and signs in. Existing verified accounts can sign in immediately. Use separate browser profiles or sign out when switching teams; tabs in the same browser share the session.
5. Existing locally approved tickets enter translation/India review, **not** final approval. Completed translations are reused. Failed translations need Local SOA's **Retry translations** action.

### Request stages and responsibilities

| Current stage | Who acts | Next step |
| --- | --- | --- |
| Request creation | Indian SOA selects the vendor and requested documents | Vendor receives the initial document request |
| Vendor upload | Vendor uploads requested/rejected files | Local SOA when all files are available |
| Local SOA | Approve/reject uploaded versions; a reason is mandatory for each rejection | Translation after all local approvals; otherwise vendor corrections |
| English translation | Local service translates the latest approved versions | Indian SOA initially, or Corporate Security after a Security correction |
| Indian SOA | View Original and View English; submit document decisions | Corporate Security when all approved; rejected documents go directly to the vendor |
| Corporate Security | View Original and View English; submit document decisions | Complete when all approved; rejected documents go directly to the vendor |
| Complete | Read-only review and history | All teams approved |

Downstream rejection immediately emails the vendor and opens only the rejected documents for replacement. Every replacement returns to Local SOA for approval and receives a new English translation. Indian SOA rejections return to Indian SOA after that cycle. Corporate Security rejections preserve the Indian SOA approval and return directly to Corporate Security after Local SOA approval and translation.

### Email notification routing

| Update | Email recipient |
| --- | --- |
| Indian SOA creates a document request | Vendor |
| Vendor finishes the currently requested uploads | Local SOA |
| Local SOA rejects a document | Vendor |
| Local SOA approves all documents and translation completes | Indian SOA, or Corporate Security for a Security correction |
| Indian SOA rejects a document | Vendor |
| Indian SOA approves all documents | Corporate Security |
| Corporate Security rejects a document | Vendor |
| Corporate Security approves all documents | Vendor, Local SOA, and Indian SOA |

Team handoff emails use the configured `PROCUREMENT_ADMIN_EMAIL`, `INDIA_PROCUREMENT_EMAIL`, and `CORPORATE_SECURITY_EMAIL` values. Vendor request and rejection emails remain visible in the Indian SOA Mail outbox. SMTP must be configured for delivery.

Decisions are staged in the page until **Submit review**. Each rejected document needs its own reason (maximum 1,000 characters). Stale or out-of-stage reviews are rejected by the backend. Original and translated files remain available to all internal review teams.

The request dashboard shows green completed steps, blue current steps, pending steps, and the correction route. Replacement uploads reset only affected progress; the history preserves earlier decisions and upload versions. Use **Refresh status** inside a request or **Refresh dashboard** after another team acts or translation finishes. When all currently requested files are uploaded, Local SOA receives an email. Vendor emails retain delivery status/retry in Indian SOA's mail outbox.

### End-to-end demo verification

1. Indian SOA creates a Mexico request with both documents; vendor registers and uploads two text-based PDFs. Confirm Local SOA receives the ready-for-review email.
2. Local SOA approves both and submits. Wait for translations to complete; refresh. India review should become current, with both original and English buttons.
3. Indian SOA approves the first and rejects the second with a reason, then submits. Confirm the vendor immediately receives the correction email and sees only the rejected file.
4. Vendor uploads the replacement. Confirm the request goes to Local SOA.
5. Vendor replaces that file. Confirm version increases, then Local SOA approves it, translation completes, and Indian SOA reviews it again. Unchanged-file approvals remain.
6. India approves the remaining file. Confirm Security becomes current.
7. Security rejects one or both files with separate reasons. Confirm the vendor receives the request directly. After vendor upload, Local SOA approval, and translation, confirm the request returns directly to Security without another Indian SOA review.
8. Security approves all remaining files. Confirm the request is **Approved**, the flow is green, and no further review controls are enabled.
9. Verify vendors cannot review documents, only Indian SOA can create requests, and no team can approve on another team's behalf.
10. Simulate a translation failure: the request must remain in translation, never enter India review. Restore LibreTranslate and use **Retry translations**.

Automated checks: run `npm test` from `server`. Tests cover routing, role restrictions, stale versions, mixed decisions, rejection reasons, replacement gating, translation completion, and role-specific UI rendering. Most tests use fake authentication/mail/database dependencies. To include the optional MySQL round-trip test after migration, run `$env:RUN_MYSQL_WORKFLOW_TEST='1'` followed by `npm test` in PowerShell. It inserts temporary records inside a transaction and rolls them back; it never sends email or writes upload files (auto-increment IDs may advance). Tests do not replace an end-to-end test with your configured accounts.

The older `onboarding_tickets.status` remains for compatibility with local review. `workflow_stage` is authoritative for overall completion; only `COMPLETED` means all teams approved. This is a single-backend local demo, not a distributed workflow worker.
