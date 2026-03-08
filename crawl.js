require('dotenv').config();
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ADDRESS      = process.env.SEARCH_ADDRESS;
const TARGET_URL   = process.env.TARGET_URL   || 'https://seereal.lh.or.kr/main.do';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const CHROME_PATH  = process.env.CHROME_PATH  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PDF_COUNT    = parseInt(process.env.PDF_COUNT || '3');
const DEBUG_PORT   = parseInt(process.env.CHROME_DEBUG_PORT || '9222');

if (!ADDRESS) throw new Error('SEARCH_ADDRESS is not set in .env');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ── Hybrid Chrome: connect to running instance or launch fresh ────────────────
let launchedBrowser = false; // track ownership so we close vs disconnect safely

async function getBrowser() {
  try {
    console.log(`   🔌 Trying to connect to existing Chrome on port ${DEBUG_PORT}...`);
    const browser = await puppeteer.connect({
      browserURL: `http://localhost:${DEBUG_PORT}`,
      defaultViewport: { width: 1280, height: 800 },
    });
    console.log('   ✅ Connected to existing Chrome (skipping launch ~3s)');
    // launchedBrowser stays false — we do NOT own this process
    return browser;
  } catch (_) {
    console.log('   ⚙️  Chrome not running — launching new instance...');
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-renderer-backgrounding',
        '--no-first-run',
        '--hide-scrollbars',
        '--mute-audio',
      ],
    });
    launchedBrowser = true; // we own this process — safe to close
    console.log('   ✅ Chrome launched');
    return browser;
  }
}

// ── Blocked resource patterns ─────────────────────────────────────────────────
const BLOCKED_TYPES    = new Set(['image', 'font', 'media', 'stylesheet', 'manifest', 'prefetch', 'websocket']);
const BLOCKED_PATTERNS = [
  'vworld', 'wmts', 'wms', 'tile',
  'googleapis', 'google-analytics', 'analytics', 'gtag',
  'doubleclick', 'googletagmanager',
];

function shouldBlock(req) {
  if (BLOCKED_TYPES.has(req.resourceType())) return true;
  const url = req.url();
  return BLOCKED_PATTERNS.some(p => url.includes(p));
}

// ── Extract rows from the current result page ─────────────────────────────────
async function extractRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('a[onclick*="settingFunc"]').forEach(el => {
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/settingFunc\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
      if (m) rows.push({ pnu: m[1], addr: m[2] });
    });
    return rows;
  });
}

// ── Navigate to a specific result page number ─────────────────────────────────
async function goToResultPage(page, pageNum) {
  await page.evaluate((n) => {
    const pg = Array.from(document.querySelectorAll('a')).find(a => {
      const oc = a.getAttribute('onclick') || '';
      return oc.includes(`fn_page(${n})`) || oc.includes(`goPage(${n})`) || a.innerText?.trim() === String(n);
    });
    if (pg) pg.click();
  }, pageNum);
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
}

// ── Open a property detail page via settingFunc ───────────────────────────────
async function callSettingFunc(page, browser, pnu, addr) {
  // Snapshot existing pages BEFORE triggering the action so we can diff afterward
  const beforePages = await browser.pages();

  await page.evaluate((p, a) => {
    mainquickSearchAddr.settingFunc(p, a);
  }, pnu, addr).catch(() => {});

  const afterPages = await browser.pages();
  // Any page present after but not before is the one we just opened
  const newTab = afterPages.find(p => !beforePages.includes(p));
  if (newTab) {
    // A real new tab was opened — wait for it to finish loading
    await newTab.waitForNetworkIdle({ idleTime: 250, timeout: 8000 }).catch(() => {});
    console.log(`   ℹ️  New tab: ${newTab.url()}`);
    return newTab;
  }
  // Same-tab navigation — content is already present, skip the idle wait
  return page;
}

// ── Worker pool ───────────────────────────────────────────────────────────────
// MAX_WORKERS caps how many Chrome tabs are open simultaneously.
// 4 is the sweet spot: fast enough for any realistic PDF_COUNT, safe for Chrome.
// Raise to 6 only on a high-RAM server; lower to 2 on slow machines.
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '4');

/**
 * A single worker: claims its pre-opened tab from the pool, drains the shared
 * task queue, generates one PDF per task, then returns the tab to the pool.
 * Tabs are never closed between tasks — only once after the full run.
 *
 * @param {object}   browser   - Puppeteer browser instance
 * @param {object[]} tabPool   - Pre-opened pages, one per worker
 * @param {object[]} queue     - Shared mutable task array {pnu, addr, idx, total}
 * @param {object[]} results   - Shared results array (written by each worker)
 * @param {number}   wid       - 1-based worker id for log readability
 */
async function worker(browser, tabPool, queue, results, wid) {
  const myTab = tabPool.pop(); // claim a pre-warmed tab — no newPage() cost here

  while (queue.length > 0) {
    const task = queue.pop();   // O(1) LIFO claim
    if (!task) break;

    const { pnu, addr, idx, total } = task;
    console.log(`📄 [W${wid}] PDF ${idx}/${total} — ${addr} (${pnu})`);
    const t = Date.now();

    try {
      const targetPage = await callSettingFunc(myTab, browser, pnu, addr);
      try { await targetPage.bringToFront(); } catch (_) {}

      const filename = `seereal_result${idx}_${Date.now()}.pdf`;
      const dest = path.join(DOWNLOAD_DIR, filename);

      await targetPage.pdf({
        path: dest,
        format: 'A4',
        printBackground: false,
        margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
        timeout: 10000,
      });

      const elapsed = Date.now() - t;
      console.log(`   ✅ Saved in ${elapsed}ms → ${dest}`);

      // Close the detail tab if the site opened a new one; keep our worker tab alive
      if (targetPage !== myTab) {
        try { await targetPage.close(); } catch (_) {}
      }

      results.push({ filename, elapsed, success: true });
    } catch (err) {
      console.log(`   ⚠️  Error on PDF ${idx}: ${err.message}`);
      results.push({ filename: null, elapsed: Date.now() - t, success: false });
    }
  }

  tabPool.push(myTab); // return tab to pool for cleanup after all workers finish
}

(async () => {
  const totalStart = Date.now();
  console.log('\n🚀 Starting RPA crawl — ' + TARGET_URL);
  console.log(`   Address  : ${ADDRESS}`);
  console.log(`   PDF Count: ${PDF_COUNT}\n`);

  // ── Step 1: Get browser (connect or launch) ─────────────────────────────
  console.log('🔧 Step 1 — Acquiring browser...');
  let t = Date.now();
  const browser = await getBrowser();
  console.log(`   ✅ Browser ready in ${Date.now() - t}ms`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Block heavy/irrelevant resources
  await page.setRequestInterception(true);
  page.on('request', req => shouldBlock(req) ? req.abort() : req.continue());

  // ── Step 2: Load homepage ───────────────────────────────────────────────
  console.log('📡 Step 2 — Loading homepage...');
  t = Date.now();
  await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  }).catch(() => {});
  await page.waitForSelector('#main_quickWord', { timeout: 90000 }).catch(() => {
    console.log('   ⚠️  #main_quickWord not found in time — proceeding anyway');
  });
  console.log(`   ✅ Loaded in ${Date.now() - t}ms`);

  // ── Step 3: Search ──────────────────────────────────────────────────────
  console.log('⌨️  Step 3 — Searching...');
  t = Date.now();

  // Wait for input to be visible (up to 3 attempts)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ready = await page.evaluate(() => {
      const el = document.querySelector('#main_quickWord');
      return !!(el && el.offsetParent !== null);
    }).catch(() => false);
    if (ready) break;
    console.log(`   ⏳ Waiting for input (attempt ${attempt})...`);
    await wait(500);
  }

  await page.evaluate((addr) => {
    const input = document.querySelector('#main_quickWord');
    if (input) {
      input.value = addr;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const btn = document.querySelector('#mainSearch_quick');
    if (btn) btn.click();
  }, ADDRESS);

  // SPA — wait for result rows selector, no navigation needed
  await page.waitForSelector('a[onclick*="settingFunc"]', { timeout: 60000 });
  console.log(`   ✅ Results loaded in ${Date.now() - t}ms`);

  // ── Step 4: Collect rows with O(1) deduplication via Set ────────────────
  console.log('📋 Step 4 — Collecting rows...');
  const seen    = new Set();     // O(1) lookup
  const allRows = [];
  let pgNum = 1;

  const addRows = (rows) => {
    for (const r of rows) {
      if (allRows.length >= PDF_COUNT) break;
      if (!seen.has(r.pnu)) {
        seen.add(r.pnu);
        allRows.push(r);
      }
    }
  };

  let rows = await extractRows(page);
  console.log(`   Page ${pgNum}: ${rows.length} rows`);
  addRows(rows);

  while (allRows.length < PDF_COUNT) {
    pgNum++;
    await goToResultPage(page, pgNum);
    rows = await extractRows(page);
    console.log(`   Page ${pgNum}: ${rows.length} rows`);
    rows.forEach(r => console.log(`      ${r.pnu} | ${r.addr}`));
    if (!rows.length) break;

    const before = allRows.length;
    addRows(rows);
    if (allRows.length === before) {
      console.log(`   ⚠️  Page ${pgNum} had no new rows — all duplicates`);
      break;
    }
  }

  const toFetch = Math.min(PDF_COUNT, allRows.length);
  console.log(`   ✅ ${allRows.length} rows — fetching ${toFetch}`);
  allRows.slice(0, toFetch).forEach((r, i) => console.log(`      ${i + 1}. ${r.addr}`));

  if (toFetch === 0) {
    await page.screenshot({ path: './debug_results.png' });
    throw new Error('No rows found — check debug_results.png');
  }

  // ── Step 5: Generate PDFs via worker pool ──────────────────────────────
  // Pre-open one tab per worker with request interception already configured.
  // Workers recycle their tab across all tasks — no newPage/close per PDF.
  // This keeps Chrome stable whether toFetch is 3 or 300.
  const taskQueue = [...allRows.slice(0, toFetch).map((r, i) => ({
    ...r, idx: i + 1, total: toFetch,
  }))];
  const results    = [];
  const workerCount = Math.min(MAX_WORKERS, toFetch); // no idle workers

  console.log(`\n⚡ Step 5 — Pre-opening ${workerCount} tabs...`);
  t = Date.now();

  // Pre-warm tabs in parallel — interception set once per tab, never again
  const tabPool = await Promise.all(
    Array.from({ length: workerCount }, async () => {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1280, height: 800 });
      await tab.setRequestInterception(true);
      tab.on('request', req => shouldBlock(req) ? req.abort() : req.continue());
      return tab;
    })
  );
  console.log(`   ✅ ${workerCount} tabs ready in ${Date.now() - t}ms`);

  console.log(`⚡ Generating ${toFetch} PDFs (${workerCount} workers)...`);
  t = Date.now();

  await Promise.all(
    Array.from({ length: workerCount }, (_, i) =>
      worker(browser, tabPool, taskQueue, results, i + 1)
    )
  );

  console.log(`   ✅ All PDFs generated in ${Date.now() - t}ms`);

  // Clean up all pooled tabs before closing the browser
  await Promise.all(tabPool.map(tab => tab.close().catch(() => {})));

  // Close only if we launched Chrome ourselves; otherwise just disconnect
  // to avoid killing the user's existing Chrome session
  if (launchedBrowser) {
    await browser.close();
  } else {
    await browser.disconnect();
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const savedPdfs = results.filter(r => r.success);
  const total     = ((Date.now() - totalStart) / 1000).toFixed(2);

  console.log('\n─────────────────────────────────────');
  console.log(`✅ Done! Saved ${savedPdfs.length}/${toFetch} PDFs in ${total}s`);
  savedPdfs.forEach((p, i) => console.log(`   ${i + 1}. ${p.filename} (${p.elapsed}ms)`));

  if      (total <= 8)  console.log('🎯 Optimal target met: ≤8s');
  else if (total <= 16) console.log('🎯 Target met: ≤16s');
  else if (total <= 30) console.log('⚡ Within 30s — deploy to Korean server for ≤16s');
  else                  console.log('🌏 Deploy to Korean server (Seoul) to meet the 16s target');
  console.log('─────────────────────────────────────\n');
})();