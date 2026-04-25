const { chromium } = require('playwright');
const path = require('path');

const SCREENSHOTS_DIR = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/screenshots';
const BASE_URL = 'http://localhost:8080';
const VIEWPORT = { width: 1440, height: 900 };

async function waitAndScreenshot(page, filePath, label) {
  await page.waitForTimeout(1000);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[OK] ${label} -> ${filePath}`);
}

async function navigateTo(page, section) {
  await page.evaluate((s) => {
    if (typeof navigate === 'function') navigate(s);
  }, section);
  await page.waitForTimeout(800);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  // 1. Home
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_home.png'), 'Home');

  // 2. Advisory
  await navigateTo(page, 'advisory');
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_advisory.png'), 'Advisory');

  // 3. Projects
  await navigateTo(page, 'projects');
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_projects.png'), 'Projects');

  // 4. Signal
  await navigateTo(page, 'signal');
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_signal.png'), 'Signal');

  // 5. Journal
  await navigateTo(page, 'journal');
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_journal.png'), 'Journal');

  // 6. About
  await navigateTo(page, 'about');
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_about.png'), 'About');

  // 7. Private Sales
  await navigateTo(page, 'private-sales');
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_private_sales.png'), 'Private Sales');

  // 8. Detail page — Signal 첫 번째 카드 클릭
  await navigateTo(page, 'signal');
  await page.waitForTimeout(800);
  // Signal 페이지 첫 번째 카드 클릭
  const firstCard = page.locator('.signal-card, .card, [data-section="signal"] .card, article').first();
  const cardExists = await firstCard.count();
  if (cardExists > 0) {
    await firstCard.click();
    await page.waitForTimeout(1000);
  } else {
    // fallback: JS로 직접 detail 뷰 시도
    await page.evaluate(() => {
      const cards = document.querySelectorAll('.signal-card, .card, article, [class*="card"]');
      if (cards.length > 0) cards[0].click();
    });
    await page.waitForTimeout(1000);
  }
  await waitAndScreenshot(page, path.join(SCREENSHOTS_DIR, 'page_detail.png'), 'Detail (Signal card)');

  await browser.close();
  console.log('\nAll screenshots saved to:', SCREENSHOTS_DIR);
})();
