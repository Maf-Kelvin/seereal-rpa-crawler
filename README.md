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

---

## How It Works

1. **Homepage load** — navigates to `seereal.lh.or.kr`
2. **Search** — fills the quick address search and submits via JS dispatch
3. **Row collection** — scrapes `settingFunc(PNU, address)` onclick args from result rows, paginating as needed to collect `PDF_COUNT` entries
4. **PDF save** — calls `settingFunc` directly for each row, waits for network idle, then prints the detail page to PDF
5. **Output** — saves `seereal_result1.pdf`, `seereal_result2.pdf`, etc. to `DOWNLOAD_DIR`

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

---

## Example Output

```
🚀 Starting RPA crawl — seereal.lh.or.kr
   Address  : 서울시 강남구
   PDF Count: 3

📡 Step 1 — Loading homepage...
   ✅ Loaded in 10322ms
⌨️  Step 2 — Searching...
   ✅ Results loaded in 1817ms
📋 Step 3 — Collecting rows...
   Page 1: 2 rows
   Page 2: 2 rows
   ✅ 3 rows — fetching 3

📄 PDF 1/3 — 서울특별시 강남구 일원동 50
   ✅ Saved in 8509ms → downloads/seereal_result1.pdf
📄 PDF 2/3 — 서울특별시 강남구 논현동 208-5
   ✅ Saved in 11372ms → downloads/seereal_result2.pdf
📄 PDF 3/3 — 서울특별시 강남구 개포동 14
   ✅ Saved in 10341ms → downloads/seereal_result3.pdf

─────────────────────────────────────
✅ Done! Saved 3/3 PDFs in 50.49s
🌏 Deploy to Korean server (Seoul) to meet the 16s target
─────────────────────────────────────
```