require('dotenv').config();
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const ADDRESS      = process.env.SEARCH_ADDRESS;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './downloads';
const CHROME_PATH  = process.env.CHROME_PATH  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PDF_COUNT    = parseInt(process.env.PDF_COUNT || '3');

if (!ADDRESS) throw new Error('SEARCH_ADDRESS is not set in .env');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function extractRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('a[onclick]').forEach(el => {
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/settingFunc\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
      if (m) rows.push({ pnu: m[1], addr: m[2] });
    });
    return rows;
  });
}

async function goToResultPage(page, pageNum) {
  await page.evaluate((n) => {
    const pg = Array.from(document.querySelectorAll('a')).find(a => {
      const oc = a.getAttribute('onclick') || '';
      return oc.includes(`fn_page(${n})`) || oc.includes(`goPage(${n})`) || a.innerText?.trim() === String(n);
    });
    if (pg) pg.click();
  }, pageNum);
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
  await wait(500);
}

async function callSettingFunc(page, browser, pnu, addr) {
  await page.evaluate((p, a) => {
    mainquickSearchAddr.settingFunc(p, a);
  }, pnu, addr).catch(() => {});

  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  await wait(300);

  const allPages = await browser.pages();
  const newTab = allPages.find(p => p !== page && p.url() !== 'about:blank');
  if (newTab) {
    console.log(`   ℹ️  New tab: ${newTab.url()}`);
    await wait(1000);
    return newTab;
  }
  return page;
}

(async () => {
  const totalStart = Date.now();
  console.log('\n🚀 Starting RPA crawl — seereal.lh.or.kr');
  console.log(`   Address  : ${ADDRESS}`);
  console.log(`   PDF Count: ${PDF_COUNT}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--disable-background-networking', '--hide-scrollbars', '--mute-audio',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    const url = req.url();
    if (['image', 'font', 'media', 'stylesheet'].includes(t)) return req.abort();
    if (url.includes('vworld') || url.includes('tile') ||
        url.includes('wmts')   || url.includes('wms'))  return req.abort();
    req.continue();
  });

  // ── Step 1: Load homepage ─────────────────────────────────────────────────
  console.log('📡 Step 1 — Loading homepage...');
  let t = Date.now();
  await page.goto('https://seereal.lh.or.kr/main.do', {
    waitUntil: 'domcontentloaded', timeout: 120000
  }).catch(() => {});
  await page.waitForSelector('#main_quickWord', { timeout: 90000 }).catch(() => {
    console.log('   ⚠️  #main_quickWord not found in time — proceeding anyway');
  });
  console.log(`   ✅ Loaded in ${Date.now() - t}ms`);

  // ── Step 2: Search — fill input via JS, wait for result rows ─────────────
  console.log('⌨️  Step 2 — Searching...');
  t = Date.now();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const ready = await page.evaluate(() => {
      const el = document.querySelector('#main_quickWord');
      return !!(el && el.offsetParent !== null);
    }).catch(() => false);
    if (ready) break;
    console.log(`   ⏳ Waiting for input (attempt ${attempt})...`);
    await wait(3000);
  }

  await page.evaluate((addr) => {
    const input = document.querySelector('#main_quickWord');
    if (input) {
      input.value = addr;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const btn = document.querySelector('#mainSearch_quick');
    if (btn) btn.click();
  }, ADDRESS);

  // Wait for result rows — no waitForNavigation, this is a SPA
  await page.waitForSelector('a[onclick*="settingFunc"]', { timeout: 60000 });
  console.log(`   ✅ Results loaded in ${Date.now() - t}ms`);

  // ── Step 3: Collect rows, paginating as needed ────────────────────────────
  console.log('📋 Step 3 — Collecting rows...');
  const allRows = [];
  let pgNum = 1;

  let rows = await extractRows(page);
  console.log(`   Page ${pgNum}: ${rows.length} rows`);
  for (const r of rows) {
    if (!allRows.find(x => x.pnu === r.pnu)) allRows.push(r);
  }

  while (allRows.length < PDF_COUNT) {
    pgNum++;
    await goToResultPage(page, pgNum);
    rows = await extractRows(page);
    console.log(`   Page ${pgNum}: ${rows.length} rows`);
    rows.forEach(r => console.log(`      ${r.pnu} | ${r.addr}`));
    if (!rows.length) break;
    let addedAny = false;
    for (const r of rows) {
      if (allRows.length >= PDF_COUNT) break;
      if (!allRows.find(x => x.pnu === r.pnu)) { allRows.push(r); addedAny = true; }
    }
    if (!addedAny) {
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

  // ── Step 4: Call settingFunc for each row, save PDF ───────────────────────
  console.log('');
  const savedPdfs = [];

  for (let i = 0; i < toFetch; i++) {
    const { pnu, addr } = allRows[i];
    console.log(`📄 PDF ${i + 1}/${toFetch} — ${addr}`);
    t = Date.now();

    try {
      const targetPage = await callSettingFunc(page, browser, pnu, addr);
      try { await targetPage.bringToFront(); } catch (_) {}

      const filename = `seereal_result${i + 1}_${Date.now()}.pdf`;
      const dest = path.join(DOWNLOAD_DIR, filename);
      await targetPage.pdf({
        path: dest, format: 'A4', printBackground: false,
        margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
        timeout: 10000,
      });

      const elapsed = Date.now() - t;
      savedPdfs.push({ filename, elapsed });
      console.log(`   ✅ Saved in ${elapsed}ms → ${dest}`);

      if (targetPage !== page) {
        try { await targetPage.close(); } catch (_) {}
        try { await page.bringToFront(); } catch (_) {}
      }
    } catch (err) {
      console.log(`   ⚠️  Error on PDF ${i + 1}: ${err.message}`);
    }
  }

  await browser.close();

  const total = ((Date.now() - totalStart) / 1000).toFixed(2);
  console.log('\n─────────────────────────────────────');
  console.log(`✅ Done! Saved ${savedPdfs.length}/${toFetch} PDFs in ${total}s`);
  savedPdfs.forEach((p, i) => console.log(`   ${i + 1}. ${p.filename} (${p.elapsed}ms)`));
  if (total <= 16) console.log('🎯 Target met: ≤16s');
  else if (total <= 30) console.log('⚡ Within 30s — deploy to Korean server for ≤16s');
  else console.log('🌏 Deploy to Korean server (Seoul) to meet the 16s target');
  console.log('─────────────────────────────────────\n');
})();