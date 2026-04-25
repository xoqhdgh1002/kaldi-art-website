const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Helper: extract text content from HTML elements, formatting headings and paragraphs
function extractBody(page, containerSelector) {
  return page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) return '';

    const result = [];

    function processNode(node) {
      const tagName = node.tagName ? node.tagName.toLowerCase() : '';

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) result.push(text);
        return;
      }

      if (!node.tagName) return;

      // Skip script, style, nav, header, footer elements
      if (['script', 'style', 'nav', 'header', 'footer', 'button'].includes(tagName)) return;

      if (tagName === 'h1') {
        const text = node.innerText.trim();
        if (text) result.push(`# ${text}`);
      } else if (tagName === 'h2') {
        const text = node.innerText.trim();
        if (text) result.push(`## ${text}`);
      } else if (tagName === 'h3') {
        const text = node.innerText.trim();
        if (text) result.push(`### ${text}`);
      } else if (tagName === 'h4') {
        const text = node.innerText.trim();
        if (text) result.push(`#### ${text}`);
      } else if (tagName === 'p') {
        const text = node.innerText.trim();
        if (text) result.push(text);
      } else if (tagName === 'ul' || tagName === 'ol') {
        const items = node.querySelectorAll('li');
        items.forEach(li => {
          const text = li.innerText.trim();
          if (text) result.push(`- ${text}`);
        });
      } else if (tagName === 'blockquote') {
        const text = node.innerText.trim();
        if (text) result.push(`> ${text}`);
      } else if (tagName === 'br') {
        // line break - handled by paragraph separation
      } else {
        // recurse into children for divs, sections, articles etc
        const children = node.childNodes;
        for (const child of children) {
          processNode(child);
        }
      }
    }

    const children = container.childNodes;
    for (const child of children) {
      processNode(child);
    }

    return result.join('\n\n');
  }, containerSelector);
}

async function extractImages(page, containerSelector) {
  return page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) return [];
    const imgs = container.querySelectorAll('img');
    const urls = [];
    imgs.forEach(img => {
      const src = img.src || img.getAttribute('src') || img.getAttribute('data-src');
      if (src && !urls.includes(src)) {
        urls.push(src);
      }
    });
    return urls;
  }, containerSelector);
}

async function scrapeNewsPage(page, url) {
  console.log(`\nScraping news page: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Get page HTML for inspection
  const pageTitle = await page.title();
  console.log(`  Page title: ${pageTitle}`);

  // Try to collect all article links from the news listing page
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href]');
    const found = new Set();
    const results = [];
    anchors.forEach(a => {
      const href = a.href;
      // Match links that look like individual news/blog posts
      if (
        href &&
        href.includes('kaldiart.com') &&
        !found.has(href) &&
        (href.includes('/news/') || href.includes('/blog/')) &&
        href !== window.location.href &&
        !href.endsWith('/news/') &&
        !href.endsWith('/blog/') &&
        !href.includes('#') &&
        !href.includes('?')
      ) {
        found.add(href);
        results.push(href);
      }
    });
    return results;
  });

  console.log(`  Found ${links.length} links`);
  return links;
}

async function scrapePost(page, url, type) {
  console.log(`  Scraping post: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      // Extract various metadata and content
      const result = {
        title: '',
        subtitle: '',
        date: '',
        location: '',
        category: '',
        coverImage: '',
        body: '',
        images: [],
        url: window.location.href,
      };

      // Title - try multiple selectors
      const titleSelectors = ['h1', '.post-title', '.article-title', '.entry-title', '[class*="title"]'];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          result.title = el.innerText.trim();
          break;
        }
      }

      // Subtitle
      const subtitleSelectors = ['h2.subtitle', '.subtitle', '.post-subtitle', '[class*="subtitle"]'];
      for (const sel of subtitleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          result.subtitle = el.innerText.trim();
          break;
        }
      }

      // Date
      const dateSelectors = ['time', '[datetime]', '.date', '.post-date', '[class*="date"]', '[class*="time"]'];
      for (const sel of dateSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          result.date = (el.getAttribute('datetime') || el.innerText).trim();
          break;
        }
      }

      // Location/Category tags
      const tagSelectors = ['.location', '.tag', '.category', '[class*="location"]', '[class*="tag"]', '[class*="category"]', '[class*="label"]'];
      for (const sel of tagSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          if (text) {
            result.location = text;
            break;
          }
        }
      }

      // Cover image - look for OG image or first large image
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        result.coverImage = ogImage.getAttribute('content') || '';
      }
      if (!result.coverImage) {
        const firstImg = document.querySelector('img');
        if (firstImg) result.coverImage = firstImg.src || '';
      }

      // All images in body content area
      const bodySelectors = [
        'article',
        'main',
        '.post-content',
        '.entry-content',
        '.article-content',
        '[class*="content"]',
        '[class*="body"]',
      ];

      let bodyEl = null;
      for (const sel of bodySelectors) {
        const el = document.querySelector(sel);
        if (el) {
          bodyEl = el;
          break;
        }
      }

      if (!bodyEl) bodyEl = document.body;

      // Extract images
      const imgs = bodyEl.querySelectorAll('img');
      const imgUrls = new Set();
      imgs.forEach(img => {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (src) imgUrls.add(src);
      });
      result.images = [...imgUrls];

      return result;
    });

    // Extract full body text with structure
    const bodySelectors = [
      'article',
      'main',
      '.post-content',
      '.entry-content',
      '.article-content',
      '[class*="content"]',
      '[class*="body"]',
    ];

    let bodyText = '';
    for (const sel of bodySelectors) {
      const exists = await page.$(sel);
      if (exists) {
        bodyText = await extractBody(page, sel);
        if (bodyText && bodyText.length > 50) break;
      }
    }

    if (!bodyText) {
      bodyText = await extractBody(page, 'body');
    }

    data.body = bodyText;

    // Generate ID from URL
    const urlPath = url.replace(/\/$/, '').split('/').pop();
    data.id = urlPath || url.split('/').filter(Boolean).pop();

    console.log(`    Title: ${data.title || '(no title found)'}`);
    console.log(`    Body length: ${data.body.length} chars`);

    return data;
  } catch (err) {
    console.error(`    ERROR scraping ${url}: ${err.message}`);
    return { url, id: url.split('/').filter(Boolean).pop(), error: err.message };
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const result = { signal: [], journal: [] };

  // ── SIGNAL (News) ─────────────────────────────────────────────────
  console.log('\n=== SCRAPING SIGNAL (NEWS) ===');
  const newsLinks = await scrapeNewsPage(page, 'https://kaldiart.com/news/');

  for (const link of newsLinks) {
    const post = await scrapePost(page, link, 'signal');
    result.signal.push(post);
    await page.waitForTimeout(1000); // polite delay
  }

  // ── JOURNAL (Blog) ───────────────────────────────────────────────
  console.log('\n=== SCRAPING JOURNAL (BLOG) ===');
  const blogLinks = await scrapeNewsPage(page, 'https://kaldiart.com/blog/');

  for (const link of blogLinks) {
    const post = await scrapePost(page, link, 'journal');
    result.journal.push(post);
    await page.waitForTimeout(1000); // polite delay
  }

  await browser.close();

  // Save results
  const outputPath = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/assets/content.json';
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log('\n=== DONE ===');
  console.log(`Signal posts: ${result.signal.length}`);
  console.log(`Journal posts: ${result.journal.length}`);
  console.log(`Saved to: ${outputPath}`);

  // Print summaries
  console.log('\n--- Signal Posts ---');
  result.signal.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.title || p.id} | ${p.date || 'no date'}`);
  });
  console.log('\n--- Journal Posts ---');
  result.journal.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.title || p.id} | ${p.date || 'no date'}`);
  });
}

main().catch(console.error);
