const { chromium } = require('playwright');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const BASE_URL = 'https://kaldiart.com';
const SAVE_DIR = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/assets/images/scraped';
const PAGES_TO_VISIT = ['/', '/advisory/', '/news/', '/blog/', '/contact/'];

// Ensure save directory exists
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
}

function resolveUrl(baseUrl, relativeUrl) {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('data:')) return null;
  if (relativeUrl.startsWith('//')) return 'https:' + relativeUrl;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return null;
  }
}

function getFilenameFromUrl(imgUrl, pageIndex, imgIndex) {
  try {
    const parsed = new URL(imgUrl);
    const basename = path.basename(parsed.pathname);
    if (basename && basename.includes('.') && !basename.startsWith('.')) {
      // Sanitize filename
      return basename.replace(/[^a-zA-Z0-9._-]/g, '_');
    }
  } catch {}
  return `page${pageIndex}-img${imgIndex}.jpg`;
}

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      console.log(`  [SKIP] Already exists: ${path.basename(destPath)}`);
      resolve({ skipped: true });
      return;
    }

    const protocol = fileUrl.startsWith('https') ? https : http;
    const tmpPath = destPath + '.tmp';
    const file = fs.createWriteStream(tmpPath);

    const request = protocol.get(fileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': BASE_URL,
      },
      timeout: 30000,
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.destroy();
        fs.unlink(tmpPath, () => {});
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          downloadFile(resolveUrl(fileUrl, redirectUrl), destPath).then(resolve).catch(reject);
        } else {
          reject(new Error(`Redirect without location: ${response.statusCode}`));
        }
        return;
      }
      if (response.statusCode !== 200) {
        file.destroy();
        fs.unlink(tmpPath, () => {});
        reject(new Error(`HTTP ${response.statusCode} for ${fileUrl}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.renameSync(tmpPath, destPath);
        resolve({ skipped: false });
      });
    });

    request.on('error', (err) => {
      file.destroy();
      fs.unlink(tmpPath, () => {});
      reject(err);
    });

    request.on('timeout', () => {
      request.destroy();
      file.destroy();
      fs.unlink(tmpPath, () => {});
      reject(new Error(`Timeout downloading: ${fileUrl}`));
    });
  });
}

async function collectImagesFromPage(page, pageUrl, pageLabel) {
  const images = [];

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    // If goto times out, still try to collect what's loaded
    console.log(`  Warning: navigation timeout, collecting what's loaded...`);
  }
  await page.waitForTimeout(3000);

  // Collect <img> src and srcset
  const imgUrls = await page.evaluate(() => {
    const urls = [];
    document.querySelectorAll('img').forEach(img => {
      if (img.src) urls.push(img.src);
      if (img.srcset) {
        img.srcset.split(',').forEach(entry => {
          const trimmed = entry.trim().split(/\s+/)[0];
          if (trimmed) urls.push(trimmed);
        });
      }
      // Also check data-src for lazy loaded images
      const dataSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
      if (dataSrc) urls.push(dataSrc);
    });
    return urls;
  });

  imgUrls.forEach(u => {
    const resolved = resolveUrl(pageUrl, u);
    if (resolved) images.push({ url: resolved, source: pageLabel });
  });

  // Collect CSS background-image URLs
  const bgUrls = await page.evaluate(() => {
    const urls = [];
    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') {
        const matches = bg.match(/url\(["']?([^"')]+)["']?\)/g);
        if (matches) {
          matches.forEach(match => {
            const urlMatch = match.match(/url\(["']?([^"')]+)["']?\)/);
            if (urlMatch && urlMatch[1]) {
              urls.push(urlMatch[1]);
            }
          });
        }
      }
      // Also check inline style
      const inlineStyle = el.getAttribute('style') || '';
      const inlineMatches = inlineStyle.match(/url\(["']?([^"')]+)["']?\)/g);
      if (inlineMatches) {
        inlineMatches.forEach(match => {
          const urlMatch = match.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch && urlMatch[1]) {
            urls.push(urlMatch[1]);
          }
        });
      }
    });
    return urls;
  });

  bgUrls.forEach(u => {
    const resolved = resolveUrl(pageUrl, u);
    if (resolved && !resolved.startsWith('data:')) {
      images.push({ url: resolved, source: pageLabel + ' [bg]' });
    }
  });

  return images;
}

async function getSubPageLinks(page, pageUrl, linkPattern) {
  try {
    const links = await page.evaluate((args) => {
      const { pattern, base } = args;
      const anchors = document.querySelectorAll('a[href]');
      const found = [];
      anchors.forEach(a => {
        const href = a.href;
        // Only include links that are on the same domain and match the pattern
        if (href && href.startsWith(base) && href.includes(pattern)) {
          // Exclude social sharing links, anchor-only links, and mailto
          if (!href.includes('facebook.com') &&
              !href.includes('twitter.com') &&
              !href.includes('x.com') &&
              !href.includes('pinterest.com') &&
              !href.includes('tumblr.com') &&
              !href.startsWith('mailto:') &&
              !href.includes('/author/') &&
              !href.includes('?') &&
              // Must have content after the pattern (not just the section itself)
              href.replace(base, '').length > pattern.length + 2
          ) {
            found.push(href);
          }
        }
      });
      return [...new Set(found)];
    }, { pattern: linkPattern, base: BASE_URL });
    return links;
  } catch (e) {
    console.error(`Error collecting links: ${e.message}`);
    return [];
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Suppress console errors from the page
  page.on('console', () => {});
  page.on('pageerror', () => {});

  const allImages = new Map(); // url -> source label
  const results = [];

  try {
    // Step 1: Visit main pages and collect images
    console.log('\n=== PHASE 1: Main Pages ===');
    for (let i = 0; i < PAGES_TO_VISIT.length; i++) {
      const pagePath = PAGES_TO_VISIT[i];
      const pageUrl = BASE_URL + pagePath;
      const pageLabel = pagePath === '/' ? 'home' : pagePath.replace(/\//g, '');
      console.log(`\nVisiting: ${pageUrl}`);

      try {
        const images = await collectImagesFromPage(page, pageUrl, pageLabel);
        console.log(`  Found ${images.length} image references`);
        images.forEach(img => {
          if (!allImages.has(img.url)) {
            allImages.set(img.url, img.source);
          }
        });

        // Collect sub-page links for /news/ and /blog/
        if (pagePath === '/news/') {
          console.log('  Collecting news article links...');
          const newsLinks = await getSubPageLinks(page, pageUrl, '/news/');
          const filteredNews = newsLinks.filter(l => l !== pageUrl && l.replace(BASE_URL, '') !== '/news/');
          console.log(`  Found ${filteredNews.length} news article links`);

          for (const link of filteredNews.slice(0, 30)) { // Limit to 30
            console.log(`  Visiting news: ${link}`);
            try {
              const subImages = await collectImagesFromPage(page, link, `news-detail: ${link}`);
              console.log(`    Found ${subImages.length} images`);
              subImages.forEach(img => {
                if (!allImages.has(img.url)) {
                  allImages.set(img.url, img.source);
                }
              });
            } catch (e) {
              console.error(`    Error on ${link}: ${e.message}`);
            }
            await page.waitForTimeout(1000);
          }
        }

        if (pagePath === '/blog/') {
          console.log('  Collecting blog post links...');
          const blogLinks = await getSubPageLinks(page, pageUrl, '/blog/');
          const filteredBlog = blogLinks.filter(l => l !== pageUrl && l.replace(BASE_URL, '') !== '/blog/');
          console.log(`  Found ${filteredBlog.length} blog post links`);

          for (const link of filteredBlog.slice(0, 30)) { // Limit to 30
            console.log(`  Visiting blog: ${link}`);
            try {
              const subImages = await collectImagesFromPage(page, link, `blog-detail: ${link}`);
              console.log(`    Found ${subImages.length} images`);
              subImages.forEach(img => {
                if (!allImages.has(img.url)) {
                  allImages.set(img.url, img.source);
                }
              });
            } catch (e) {
              console.error(`    Error on ${link}: ${e.message}`);
            }
            await page.waitForTimeout(1000);
          }
        }
      } catch (e) {
        console.error(`  Error visiting ${pageUrl}: ${e.message}`);
      }
    }

    console.log(`\n=== PHASE 2: Download ${allImages.size} unique image URLs ===`);

    // Filter to only images (skip SVG data URIs, very small files, fonts, etc.)
    const imageEntries = [...allImages.entries()].filter(([imgUrl]) => {
      if (imgUrl.startsWith('data:')) return false;
      const lower = imgUrl.toLowerCase();
      // Include common image extensions + unknown extension URLs
      const isImageExt = /\.(jpg|jpeg|png|gif|webp|avif|svg|ico|bmp|tiff?)(\?|$)/i.test(lower);
      const isFromImagePath = lower.includes('/images/') || lower.includes('/uploads/') ||
                               lower.includes('/media/') || lower.includes('/assets/') ||
                               lower.includes('/wp-content/') || lower.includes('/static/');
      return isImageExt || isFromImagePath;
    });

    console.log(`  Filtered to ${imageEntries.length} image URLs (excluded data URIs and non-images)`);

    let pageCounters = {};
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < imageEntries.length; i++) {
      const [imgUrl, source] = imageEntries[i];

      // Generate unique filename
      let filename = getFilenameFromUrl(imgUrl, i, i);

      // Handle duplicate filenames
      let destPath = path.join(SAVE_DIR, filename);
      if (fs.existsSync(destPath)) {
        // Check if it's actually the same URL by comparing
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        let counter = 1;
        while (fs.existsSync(path.join(SAVE_DIR, `${base}_${counter}${ext}`))) {
          counter++;
        }
        // Only rename if the existing file is from a different URL
        // We skip same URLs via the Map deduplication above
        filename = `${base}_${counter}${ext}`;
        destPath = path.join(SAVE_DIR, filename);
      }

      console.log(`\n[${i + 1}/${imageEntries.length}] Downloading: ${filename}`);
      console.log(`  Source: ${source}`);
      console.log(`  URL: ${imgUrl}`);

      try {
        const result = await downloadFile(imgUrl, destPath);
        if (result.skipped) {
          skipped++;
          results.push({ filename, url: imgUrl, source, status: 'skipped' });
        } else {
          downloaded++;
          const size = fs.statSync(destPath).size;
          console.log(`  Saved: ${filename} (${(size / 1024).toFixed(1)} KB)`);
          results.push({ filename, url: imgUrl, source, status: 'downloaded', size });
        }
      } catch (e) {
        failed++;
        console.error(`  FAILED: ${e.message}`);
        results.push({ filename, url: imgUrl, source, status: 'failed', error: e.message });
      }

      // Small delay to be respectful
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n=== SUMMARY ===');
    console.log(`Total unique URLs found: ${allImages.size}`);
    console.log(`Image URLs processed: ${imageEntries.length}`);
    console.log(`Downloaded: ${downloaded}`);
    console.log(`Skipped (already exists): ${skipped}`);
    console.log(`Failed: ${failed}`);

    // Write report
    const reportPath = path.join(SAVE_DIR, '_download_report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: { total: imageEntries.length, downloaded, skipped, failed },
      files: results
    }, null, 2));
    console.log(`\nReport saved: ${reportPath}`);

    // Print final mapping
    console.log('\n=== FILE MAPPING ===');
    results.forEach(r => {
      console.log(`${r.status.toUpperCase()} | ${r.filename} | ${r.source} | ${r.url}`);
    });

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
