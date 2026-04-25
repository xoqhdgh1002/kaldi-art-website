const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  const baseUrl = 'http://localhost:18432/index.html';
  const outputDir = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/';

  const pages = [
    { id: 'home',     file: 'preview_home.png' },
    { id: 'advisory', file: 'preview_advisory.png' },
    { id: 'projects', file: 'preview_projects.png' },
    { id: 'artists',  file: 'preview_artists.png' },
    { id: 'signal',   file: 'preview_signal.png' },
    { id: 'journal',  file: 'preview_journal.png' },
    { id: 'about',    file: 'preview_about.png' },
  ];

  console.log('Loading page...');
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  for (const p of pages) {
    console.log(`Navigating to: ${p.id}`);
    await page.evaluate((pageId) => {
      if (typeof navigate === 'function') {
        navigate(pageId);
      } else {
        console.error('navigate function not found');
      }
    }, p.id);
    await page.waitForTimeout(1000);

    const filePath = outputDir + p.file;
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`Saved: ${filePath}`);
  }

  await browser.close();
  console.log('All screenshots taken.');
})();
