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

> This is a functional prototype, not a production system. Do not use real vendor documents or confidential information. Production storage must be encrypted and governed by appropriate access, retention, scanning, and audit controls.
