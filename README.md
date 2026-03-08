# Quest 1 — RPA Crawler: seereal.lh.or.kr

Automated RPA script that searches a Korean real estate portal by address, extracts property detail pages, and saves them as PDFs locally.

---

## Project Structure

```
seereal-rpa-crawler/
├── crawl.js          # Main RPA script
├── .env              # Local environment variables (not committed)
├── .env.example      # Environment variable template
├── .gitignore
├── package.json
├── package-lock.json
└── downloads/        # Output folder for saved PDFs (auto-created)
```

---

## Requirements

- Node.js v18+
- Google Chrome installed
- Internet connection

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/MUST.git
cd MUST
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the example file and edit it:

```bash
cp .env.example .env
```

Edit `.env`:

```env
SEARCH_ADDRESS=서울시 강남구
PDF_COUNT=3
DOWNLOAD_DIR=./downloads
MAX_WORKERS=4
CHROME_DEBUG_PORT=9222

# macOS
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Windows
# CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe

# Linux
# CHROME_PATH=/usr/bin/chromium-browser
```

---

## Usage

```bash
npm start
```

PDFs are saved to the `./downloads` folder (or whatever `DOWNLOAD_DIR` is set to).

### Reusing an existing Chrome session

If Chrome is already running with remote debugging enabled, the script will connect to it instead of launching a new instance — saving ~3s per run. Start Chrome manually with:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Windows
chrome.exe --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

---

## How It Works

1. **Browser acquisition** — connects to an existing Chrome on `CHROME_DEBUG_PORT` if available, otherwise launches a new headless instance. On disconnect, the script calls `browser.disconnect()` (not `close()`) to preserve any existing session.
2. **Homepage load** — navigates to `seereal.lh.or.kr` with all images, fonts, stylesheets, and tracker domains blocked to reduce load time.
3. **Search** — fills the quick address search and submits via JS event dispatch; waits for result rows via selector rather than navigation.
4. **Row collection** — scrapes `settingFunc(PNU, address)` onclick args from result rows using a `Set` for O(1) deduplication, paginating as needed to collect `PDF_COUNT` entries.
5. **Tab pool setup** — pre-opens `MAX_WORKERS` tabs in parallel (default: 4), each with request interception configured once.
6. **PDF generation** — a worker pool drains a shared task queue (LIFO). Each worker reuses its pre-opened tab across all tasks, calling `settingFunc` per row and printing the detail page to PDF. `waitForNetworkIdle` fires only when a new tab is opened by the site.
7. **Output** — saves `seereal_result1.pdf`, `seereal_result2.pdf`, etc. to `DOWNLOAD_DIR`. Tab pool is closed cleanly before the browser exits.

---

## Performance

| Environment | Expected Total Time |
|-------------|-------------------|
| Windows (Korea) | ~8–16s ✅ |
| macOS (outside Korea) | ~30–60s |
| Linux server (Seoul) | ~8–12s ✅ |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_ADDRESS` | *(required)* | Korean address to search |
| `PDF_COUNT` | `3` | Number of PDFs to download |
| `DOWNLOAD_DIR` | `./downloads` | Output folder for PDFs |
| `CHROME_PATH` | `/Applications/Google Chrome.app/...` | Path to Chrome executable |
| `CHROME_DEBUG_PORT` | `9222` | Remote debugging port to connect to an existing Chrome |
| `MAX_WORKERS` | `4` | Number of parallel worker tabs for PDF generation |

---

## Example Output

```
🚀 Starting RPA crawl — seereal.lh.or.kr
   Address  : 서울시 강남구
   PDF Count: 3

🔧 Step 1 — Acquiring browser...
   🔌 Trying to connect to existing Chrome on port 9222...
   ✅ Connected to existing Chrome (skipping launch ~3s)
   ✅ Browser ready in 187ms
📡 Step 2 — Loading homepage...
   ✅ Loaded in 1423ms
⌨️  Step 3 — Searching...
   ✅ Results loaded in 1104ms
📋 Step 4 — Collecting rows...
   Page 1: 10 rows
   ✅ 3 rows — fetching 3

⚡ Step 5 — Pre-opening 3 tabs...
   ✅ 3 tabs ready in 312ms
⚡ Generating 3 PDFs (3 workers)...
   📄 [W1] PDF 3/3 — 서울특별시 강남구 개포동 14 (1168010100...)
   📄 [W2] PDF 2/3 — 서울특별시 강남구 논현동 208-5 (1168010200...)
   📄 [W3] PDF 1/3 — 서울특별시 강남구 일원동 50 (1168010300...)
   ✅ Saved in 2341ms → downloads/seereal_result3.pdf
   ✅ Saved in 2489ms → downloads/seereal_result2.pdf
   ✅ Saved in 2612ms → downloads/seereal_result1.pdf
   ✅ All PDFs generated in 2701ms

─────────────────────────────────────
✅ Done! Saved 3/3 PDFs in 6.21s
🎯 Optimal target met: ≤8s
─────────────────────────────────────
```