const { chromium } = require('playwright');
const fs = require('fs');

// Noise phrases to strip from extracted text
const NOISE_PATTERNS = [
  /^Skip to .*/i,
  /^Open a larger version of the following image in a popup/i,
  /^Share$/i,
  /^- Facebook$/i,
  /^- X$/i,
  /^- Pinterest$/i,
  /^- Tumblr$/i,
  /^- Email$/i,
  /^- Reddit$/i,
  /^- LinkedIn$/i,
  /^- Twitter$/i,
  /^- WhatsApp$/i,
  /^- Copy Link$/i,
  /^Subscribe$/i,
  /^Newsletter$/i,
  /^Back to (News|Blog|Journal|Signal)/i,
  /^Previous post$/i,
  /^Next post$/i,
  /^Comments$/i,
  /^Leave a (comment|reply)/i,
  /^Copyright/i,
  /^All rights reserved/i,
  /^KALDI ART\s*$/i,
  /^Menu$/i,
  /^Navigation$/i,
  /^Search$/i,
  /^Login$/i,
  /^Sign up$/i,
];

function isNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return NOISE_PATTERNS.some(re => re.test(trimmed));
}

function cleanBody(text) {
  if (!text) return '';
  const lines = text.split('\n\n');
  const cleaned = lines.filter(block => {
    const trimmed = block.trim();
    if (!trimmed) return false;
    if (isNoiseLine(trimmed)) return false;
    // Remove pure social/share blocks
    const subLines = trimmed.split('\n');
    if (subLines.every(l => isNoiseLine(l) || !l.trim())) return false;
    return true;
  });
  return cleaned.join('\n\n').trim();
}

async function extractBodyText(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;

    const text = await page.evaluate((selector) => {
      const container = document.querySelector(selector);
      if (!container) return '';

      const result = [];

      function processNode(node) {
        const tagName = node.tagName ? node.tagName.toLowerCase() : '';

        // Skip unwanted elements
        if (['script', 'style', 'noscript', 'iframe', 'button', 'form', 'input', 'textarea', 'select'].includes(tagName)) return;

        // Skip nav-like elements by class/id
        if (node.tagName) {
          const cls = (node.className || '').toString().toLowerCase();
          const id = (node.id || '').toLowerCase();
          if (/(nav|navigation|menu|sidebar|share|social|footer|header|breadcrumb|pagination|cookie|popup|modal|banner|advertisement|widget)/.test(cls + id)) return;
        }

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
        } else if (tagName === 'h5' || tagName === 'h6') {
          const text = node.innerText.trim();
          if (text) result.push(`##### ${text}`);
        } else if (tagName === 'p') {
          const text = node.innerText.trim();
          if (text) result.push(text);
        } else if (tagName === 'ul') {
          const items = node.querySelectorAll(':scope > li');
          items.forEach(li => {
            const text = li.innerText.trim();
            if (text) result.push(`- ${text}`);
          });
        } else if (tagName === 'ol') {
          const items = node.querySelectorAll(':scope > li');
          items.forEach((li, i) => {
            const text = li.innerText.trim();
            if (text) result.push(`${i + 1}. ${text}`);
          });
        } else if (tagName === 'blockquote') {
          const text = node.innerText.trim();
          if (text) result.push(`> ${text}`);
        } else if (tagName === 'hr') {
          result.push('---');
        } else {
          // Recurse into children for divs, sections, articles etc.
          const children = node.childNodes;
          for (const child of children) {
            processNode(child);
          }
        }
      }

      for (const child of container.childNodes) {
        processNode(child);
      }

      return result.join('\n\n');
    }, sel);

    if (text && text.length > 100) {
      return text;
    }
  }
  return '';
}

async function scrapeListingLinks(page, url, type) {
  console.log(`\nScraping listing: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const pathSegment = type === 'signal' ? '/news/' : '/blog/';

  const links = await page.evaluate(({ pathSeg, baseUrl }) => {
    const anchors = document.querySelectorAll('a[href]');
    const found = new Set();
    const results = [];
    anchors.forEach(a => {
      const href = a.href;
      if (
        href &&
        href.includes('kaldiart.com') &&
        href.includes(pathSeg) &&
        !found.has(href) &&
        href !== baseUrl &&
        !href.endsWith(pathSeg) &&
        !href.includes('/author/') &&
        !href.includes('/page/') &&
        !href.includes('/tag/') &&
        !href.includes('/category/') &&
        !href.includes('#') &&
        !href.includes('?')
      ) {
        found.add(href);
        results.push(href);
      }
    });
    return results;
  }, { pathSeg: pathSegment, baseUrl: url });

  console.log(`  Found ${links.length} links`);
  return links;
}

async function scrapePost(page, url) {
  console.log(`  Scraping: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    const meta = await page.evaluate(() => {
      const r = {
        title: '',
        subtitle: '',
        date: '',
        location: '',
        category: '',
        coverImage: '',
        images: [],
      };

      // OG image for cover
      const og = document.querySelector('meta[property="og:image"]');
      if (og) r.coverImage = og.getAttribute('content') || '';

      // Title: prefer h1
      const h1 = document.querySelector('h1');
      if (h1) r.title = h1.innerText.trim();

      // Date: look for time element or date-like classes
      const timeEl = document.querySelector('time');
      if (timeEl) {
        r.date = (timeEl.getAttribute('datetime') || timeEl.innerText || '').trim().toUpperCase();
      }
      if (!r.date) {
        const dateEl = document.querySelector('[class*="date"], [class*="time"], .entry-date, .post-date, .published');
        if (dateEl) r.date = dateEl.innerText.trim().toUpperCase();
      }

      // Location/category - look for tags near the top
      const tagEls = document.querySelectorAll('[class*="tag"], [class*="label"], [class*="location"], [class*="category"], [class*="region"]');
      tagEls.forEach(el => {
        const text = el.innerText.trim();
        if (text && text.length < 60 && !r.location) r.location = text.toUpperCase();
      });

      // Collect all images from the page (body area)
      const bodyArea = document.querySelector('article, main, [class*="content"], [class*="body"]') || document.body;
      const imgs = bodyArea.querySelectorAll('img');
      const imgSet = new Set();
      imgs.forEach(img => {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (src && src.startsWith('http')) imgSet.add(src);
      });
      r.images = [...imgSet];

      return r;
    });

    // Extract body text from most specific content container
    const bodySelectors = [
      'article .entry-content',
      'article .post-content',
      'article .content',
      '.entry-content',
      '.post-content',
      '.article-content',
      '.blog-content',
      '.news-content',
      'article',
      'main .content',
      'main',
    ];

    let bodyText = await extractBodyText(page, bodySelectors);
    bodyText = cleanBody(bodyText);

    // Generate ID from URL slug
    const slug = url.replace(/\/$/, '').split('/').pop();

    const post = {
      id: slug,
      title: meta.title,
      subtitle: meta.subtitle,
      date: meta.date,
      location: meta.location,
      category: meta.category,
      coverImage: meta.coverImage,
      body: bodyText,
      images: meta.images,
      url,
    };

    console.log(`    Title: ${post.title || '(none)'} | Date: ${post.date || '(none)'} | Body: ${post.body.length} chars`);
    return post;
  } catch (err) {
    console.error(`    ERROR: ${err.message}`);
    return {
      id: url.replace(/\/$/, '').split('/').pop(),
      url,
      error: err.message,
      title: '', subtitle: '', date: '', location: '', category: '',
      coverImage: '', body: '', images: [],
    };
  }
}

// Deduplicate by title, keeping first occurrence (prefer full-slug URL)
function deduplicateByTitle(posts) {
  const seen = new Set();
  return posts.filter(p => {
    if (seen.has(p.title)) return false;
    seen.add(p.title);
    return true;
  });
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

  // SIGNAL
  console.log('\n======== SIGNAL (NEWS) ========');
  const newsLinks = await scrapeListingLinks(page, 'https://kaldiart.com/news/', 'signal');
  for (const link of newsLinks) {
    const post = await scrapePost(page, link);
    result.signal.push(post);
    await page.waitForTimeout(800);
  }

  // JOURNAL
  console.log('\n======== JOURNAL (BLOG) ========');
  const blogLinks = await scrapeListingLinks(page, 'https://kaldiart.com/blog/', 'journal');
  for (const link of blogLinks) {
    const post = await scrapePost(page, link);
    result.journal.push(post);
    await page.waitForTimeout(800);
  }

  // Clean up duplicates
  result.journal = deduplicateByTitle(result.journal);

  await browser.close();

  const outputPath = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/assets/content.json';
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

  // Summary
  console.log('\n======== SUMMARY ========');
  console.log(`Signal posts: ${result.signal.length}`);
  console.log(`Journal posts: ${result.journal.length}`);
  console.log(`Output: ${outputPath}`);
  console.log('\n--- Signal ---');
  result.signal.forEach((p, i) => {
    console.log(`  [${i+1}] ${p.title || p.id} | ${p.date} | body: ${p.body.length}c`);
  });
  console.log('\n--- Journal ---');
  result.journal.forEach((p, i) => {
    console.log(`  [${i+1}] ${p.title || p.id} | ${p.date} | body: ${p.body.length}c`);
  });
}

main().catch(console.error);
