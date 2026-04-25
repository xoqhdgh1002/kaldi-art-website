const { chromium } = require('playwright');
const fs = require('fs');

// Extract structured text from a container element
async function extractBodyText(page, selector) {
  return page.evaluate((sel) => {
    const container = document.querySelector(sel);
    if (!container) return '';

    const result = [];

    function processNode(node) {
      const tagName = node.tagName ? node.tagName.toLowerCase() : '';
      if (['script', 'style', 'noscript', 'button', 'form', 'input'].includes(tagName)) return;

      if (tagName === 'h1') {
        const t = node.innerText.trim();
        if (t) result.push('# ' + t);
      } else if (tagName === 'h2') {
        const t = node.innerText.trim();
        if (t) result.push('## ' + t);
      } else if (tagName === 'h3') {
        const t = node.innerText.trim();
        if (t) result.push('### ' + t);
      } else if (tagName === 'h4') {
        const t = node.innerText.trim();
        if (t) result.push('#### ' + t);
      } else if (tagName === 'h5' || tagName === 'h6') {
        const t = node.innerText.trim();
        if (t) result.push('##### ' + t);
      } else if (tagName === 'p') {
        const t = node.innerText.trim();
        if (t) result.push(t);
      } else if (tagName === 'ul') {
        node.querySelectorAll(':scope > li').forEach(li => {
          const t = li.innerText.trim();
          if (t) result.push('- ' + t);
        });
      } else if (tagName === 'ol') {
        node.querySelectorAll(':scope > li').forEach((li, i) => {
          const t = li.innerText.trim();
          if (t) result.push((i + 1) + '. ' + t);
        });
      } else if (tagName === 'blockquote') {
        const t = node.innerText.trim();
        if (t) result.push('> ' + t);
      } else if (tagName === 'hr') {
        result.push('---');
      } else {
        for (const child of node.childNodes) {
          processNode(child);
        }
      }
    }

    for (const child of container.childNodes) {
      processNode(child);
    }

    return result.join('\n\n');
  }, selector);
}

// Noise lines to filter out
const NOISE = [
  /^Open a larger version of the following image in a popup\.?$/i,
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
  /^Subscribe(\.| to)?$/i,
  /^Skip to .*/i,
  /^Back to (News|Blog|Journal|Signal)$/i,
];

function cleanBody(text) {
  if (!text) return '';
  return text
    .split('\n\n')
    .filter(block => {
      const t = block.trim();
      if (!t) return false;
      // Remove if all sub-lines are noise
      const lines = t.split('\n').filter(l => l.trim());
      if (lines.length === 0) return false;
      if (lines.every(l => NOISE.some(re => re.test(l.trim())))) return false;
      return true;
    })
    .join('\n\n')
    .trim();
}

async function getListingLinks(page, url, pathSeg) {
  console.log(`\nListing: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const links = await page.evaluate(({ pathSeg, pageUrl }) => {
    const found = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (
        href &&
        href.includes('kaldiart.com') &&
        href.includes(pathSeg) &&
        !found.has(href) &&
        href !== pageUrl &&
        !href.endsWith(pathSeg) &&
        !href.includes('/author/') &&
        !href.includes('/page/') &&
        !href.includes('/tag/') &&
        !href.includes('/category/') &&
        !href.includes('#') &&
        !href.includes('?')
      ) {
        found.add(href);
      }
    });
    return [...found];
  }, { pathSeg, pageUrl: url });

  console.log(`  Found ${links.length} links`);
  return links;
}

async function scrapePost(page, url) {
  console.log(`  -> ${url}`);
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

      // Cover image from OG
      const og = document.querySelector('meta[property="og:image"]');
      if (og) r.coverImage = og.getAttribute('content') || '';

      // Title from h1
      const h1 = document.querySelector('h1');
      if (h1) r.title = h1.innerText.trim();

      // Date
      const timeEl = document.querySelector('time');
      if (timeEl) {
        r.date = (timeEl.getAttribute('datetime') || timeEl.innerText || '').trim().toUpperCase();
      }
      if (!r.date) {
        const dateEl = document.querySelector('.entry-date, .post-date, .published, [class*="date"]');
        if (dateEl) r.date = dateEl.innerText.trim().toUpperCase();
      }

      // Location/tag (first short tag-like element)
      const tagCandidates = document.querySelectorAll('[class*="tag"], [class*="label"], [class*="location"], [class*="region"]');
      for (const el of tagCandidates) {
        const t = el.innerText.trim();
        if (t && t.length < 50 && !t.includes('\n')) {
          r.location = t.toUpperCase();
          break;
        }
      }

      // All images in content module
      const contentEl = document.querySelector('#content_module') || document.querySelector('#content') || document.body;
      const imgSet = new Set();
      contentEl.querySelectorAll('img').forEach(img => {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (src && src.startsWith('http')) imgSet.add(src);
      });
      r.images = [...imgSet];

      return r;
    });

    // Extract body from #content_module (site-specific selector)
    let bodyText = await extractBodyText(page, '#content_module');
    if (!bodyText || bodyText.length < 50) {
      // Fallback chain
      for (const sel of ['#content', 'article', 'main', '.prose']) {
        bodyText = await extractBodyText(page, sel);
        if (bodyText && bodyText.length > 50) break;
      }
    }

    bodyText = cleanBody(bodyText);

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

    console.log(`     "${post.title}" | ${post.date} | ${post.body.length} chars`);
    return post;
  } catch (err) {
    console.error(`  ERROR ${url}: ${err.message}`);
    return {
      id: url.replace(/\/$/, '').split('/').pop(),
      url, error: err.message,
      title: '', subtitle: '', date: '', location: '', category: '',
      coverImage: '', body: '', images: [],
    };
  }
}

function dedup(posts) {
  const seen = new Set();
  return posts.filter(p => {
    if (!p.title || seen.has(p.title)) return false;
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
  page.setDefaultTimeout(60000);

  const result = { signal: [], journal: [] };

  // Signal
  console.log('\n======= SIGNAL (NEWS) =======');
  const newsLinks = await getListingLinks(page, 'https://kaldiart.com/news/', '/news/');
  for (const link of newsLinks) {
    const post = await scrapePost(page, link);
    result.signal.push(post);
    await page.waitForTimeout(700);
  }

  // Journal
  console.log('\n======= JOURNAL (BLOG) =======');
  const blogLinks = await getListingLinks(page, 'https://kaldiart.com/blog/', '/blog/');
  for (const link of blogLinks) {
    const post = await scrapePost(page, link);
    result.journal.push(post);
    await page.waitForTimeout(700);
  }

  // Deduplicate journal (same post, different URL slug lengths)
  result.journal = dedup(result.journal);

  await browser.close();

  const outputPath = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/assets/content.json';
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log('\n======= DONE =======');
  console.log(`Signal: ${result.signal.length} posts`);
  console.log(`Journal: ${result.journal.length} posts`);
  console.log(`Output: ${outputPath}`);

  console.log('\n--- Signal Posts ---');
  result.signal.forEach((p, i) => {
    console.log(`  [${i+1}] ${p.title} | ${p.date} | body: ${p.body.length}c | imgs: ${p.images.length}`);
  });
  console.log('\n--- Journal Posts ---');
  result.journal.forEach((p, i) => {
    console.log(`  [${i+1}] ${p.title} | ${p.date} | body: ${p.body.length}c | imgs: ${p.images.length}`);
  });
}

main().catch(console.error);
