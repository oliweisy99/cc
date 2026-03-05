# Course Concierge — AI-Powered Weekly Data Reports

An intelligent local web app that autonomously learns how to populate weekly Google Sheets
reports by reading the existing sheet structure and letting Claude figure out what to fetch.

---

## How It Works

```
1. Read Sheet  →  2. Claude Analyses  →  3. Fetch GA + SamCart  →  4. Claude Formats  →  5. Write Sheet  →  6. Validate
```

**The AI never sees hardcoded column names.** It reads your sheet, infers what every column
means, decides which APIs to call, fetches the data, and formats a perfect new row.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up credentials
```bash
cp .env.example .env
# Then edit .env with your real values
```

### 3. Add your Google service account
Place your `service-account.json` file in the project root. The service account needs:
- **Google Sheets API** — Editor access on the target spreadsheet
  *(Share the sheet with the service account email, e.g. `my-bot@my-project.iam.gserviceaccount.com`)*
- **Google Analytics Data API** — Viewer access on the GA4 property

### 4. Start the server
```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 5. Open the app
Visit [http://localhost:3000](http://localhost:3000)

---

## Credential Setup Guide

### Google Service Account
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable these APIs:
   - **Google Sheets API**
   - **Google Analytics Data API**
4. Go to **IAM & Admin → Service Accounts**
5. Create a service account, download the JSON key
6. Save it as `service-account.json` in the project root
7. Share your Google Sheet with the service account email (Editor role)
8. Add the service account to your GA4 property (Viewer role) via Google Analytics Admin

### Google Analytics Property ID
- Go to Google Analytics → Admin → Property Settings
- Copy the numeric **Property ID** (e.g. `123456789`)
- It appears after `properties/` in the API path

### SamCart API Key
- Log in to SamCart → Settings → API
- Copy your API key

---

## Adding New Clients

Edit the `CLIENTS` array at the top of [server.js](server.js):

```js
const CLIENTS = [
  {
    id: 'client1',
    name: 'Acme Corp',
    sheetId: 'your-sheet-id',
    sheetTab: 'Weekly Reports',
    gaPropertyId: '123456789',
    samcartApiKey: 'sk_...',
  },
  // Add more clients here
];
```

Or use environment variables via `.env`:
```
CLIENT2_GOOGLE_SHEET_ID=...
CLIENT2_GA_PROPERTY_ID=...
CLIENT2_SAMCART_API_KEY=...
```

---

## Features

| Feature | Description |
|---|---|
| **AI Sheet Analysis** | Claude reads your sheet and infers every column's source, type, and format |
| **Autonomous Fetch Plan** | Claude decides which GA metrics and SamCart fields to pull — no hardcoding |
| **Live Reasoning Log** | Watch every AI decision stream to the browser in real time |
| **Analysis Cache** | Claude's schema is cached to `analysis-cache.json` — no re-analysis every run |
| **Re-analyze Button** | Force a fresh Claude analysis any time the sheet structure changes |
| **Manual Override** | Paste your own JSON schema to skip AI analysis entirely |
| **Self-Validation** | After writing, the app reads back the row and checks for discrepancies |
| **Multi-client** | Each client has isolated credentials, sheet, and cached analysis |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/clients` | List clients with cache status |
| `GET` | `/api/run-report/:clientId` | SSE stream — runs the full pipeline |
| `GET` | `/api/run-report/:clientId?reanalyze=true` | Force re-analysis before running |
| `POST` | `/api/override-schema/:clientId` | Save a manual schema override |
| `GET` | `/api/cache` | View raw analysis cache |
| `DELETE` | `/api/cache/:clientId` | Clear cache for one client |

---

## Project Structure

```
courseConcierge/
├── server.js              # Express server + full pipeline logic
├── package.json
├── .env                   # Your credentials (git-ignored)
├── .env.example           # Template
├── service-account.json   # Google service account key (git-ignored)
├── analysis-cache.json    # Auto-generated after first run (git-ignored)
├── public/
│   ├── index.html         # Web UI with live SSE updates
│   └── styles.css         # Dark theme styling
└── README.md
```

---

## Claude API Usage

Each report run uses **2–3 Claude API calls**:

1. **Sheet Analysis** (~1000 token input, ~800 output) — skipped if cached
2. **Data Formatting** (~2000 token input, ~200 output) — always runs

Using `claude-sonnet-4-20250514` as specified.
