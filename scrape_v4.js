const { chromium } = require('playwright');
const fs = require('fs');

async function loginPage(page, url, username, password) {
  console.log(`\n접속: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log('Title:', title);
  if (!title.toLowerCase().includes('login') && !title.toLowerCase().includes('protected')) {
    console.log('→ 로그인 불필요');
    return true;
  }

  // 폼 전체 구조 확인
  const formInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
    }));
    return { inputs };
  });
  console.log('Form inputs:', JSON.stringify(formInfo.inputs));

  // Username 필드
  const usernameInput = await page.$('#username, input[name="username"], input[type="text"]');
  if (usernameInput) {
    await usernameInput.click({ force: true });
    await usernameInput.fill(username);
    console.log('Username 입력 완료');
  }

  // Password 필드
  const pwInput = await page.$('#password, input[name="password"], input[type="password"]');
  if (pwInput) {
    await pwInput.click({ force: true });
    await pwInput.fill(password);
    console.log('Password 입력 완료');
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/before_submit_${Date.now()}.png` });

  // 폼 제출
  try {
    await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) form.submit();
    });
  } catch(e) {}

  await page.waitForTimeout(4000);
  const newTitle = await page.title();
  const newUrl = page.url();
  console.log('제출 후 Title:', newTitle);
  console.log('제출 후 URL:', newUrl);
  await page.screenshot({ path: `/tmp/after_submit_${Date.now()}.png` });

  return !newTitle.toLowerCase().includes('login') && !newTitle.toLowerCase().includes('protected');
}

async function scrapeFull(page) {
  await page.waitForTimeout(1000);
  return await page.evaluate(() => {
    const images = Array.from(document.querySelectorAll('img, [style*="background-image"]')).map(el => {
      if (el.tagName === 'IMG') return { type: 'img', src: el.src, alt: el.alt };
      const style = el.getAttribute('style') || '';
      const match = style.match(/url\(['"]?(.+?)['"]?\)/);
      return match ? { type: 'bg', src: match[1] } : null;
    }).filter(Boolean);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim(), href: a.href }))
      .filter(l => l.href.includes('kaldiart.com') && l.text);

    // 구조화된 데이터 추출
    const structured = {};
    // h2 기준 섹션 분리
    document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
      const text = h.textContent.trim();
      if (text) structured[text] = h.nextElementSibling?.textContent?.trim() || '';
    });

    return {
      title: document.title,
      url: window.location.href,
      bodyText: document.body.innerText,
      images,
      links,
      structured
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  const page = await context.newPage();
  const results = {};

  // ── Artists ──
  const aOk = await loginPage(page, 'https://kaldiart.com/artists', 'KALDI ARTWORKS', 'Kaldi2425');
  const artistsData = await scrapeFull(page);
  results.artists = { loggedIn: aOk, ...artistsData };
  console.log('\n=== Artists 전체 텍스트 ===');
  console.log(artistsData.bodyText.substring(0, 3000));
  console.log('\n링크들:', artistsData.links.slice(0, 20));

  // ── Projects ──
  const pOk = await loginPage(page, 'https://kaldiart.com/exhibitions', 'KALDI ARTWORKS', 'Kaldi2425');
  const projectsData = await scrapeFull(page);
  results.projects = { loggedIn: pOk, ...projectsData };
  console.log('\n=== Projects 전체 텍스트 ===');
  console.log(projectsData.bodyText.substring(0, 3000));
  console.log('\n링크들:', projectsData.links.slice(0, 20));

  // 개별 아티스트 페이지
  const artistSubLinks = artistsData.links.filter(l =>
    (l.href.includes('/artist') || l.href.match(/kaldiart\.com\/[a-z-]+\/[a-z-]+/)) && !l.href.endsWith('/artists')
  );
  console.log('\n발견된 아티스트 링크:', artistSubLinks.length, artistSubLinks);

  const projectSubLinks = projectsData.links.filter(l =>
    (l.href.includes('/exhibition') || l.href.includes('/project')) && !l.href.endsWith('/exhibitions')
  );
  console.log('발견된 프로젝트 링크:', projectSubLinks.length, projectSubLinks);

  // 개별 페이지 스크래핑
  results.artistDetails = [];
  for (const link of artistSubLinks.slice(0, 30)) {
    try {
      await page.goto(link.href, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1000);
      const d = await scrapeFull(page);
      results.artistDetails.push(d);
      console.log('  아티스트 페이지:', d.title);
    } catch(e) { console.log('  실패:', link.href); }
  }

  results.projectDetails = [];
  for (const link of projectSubLinks.slice(0, 30)) {
    try {
      await page.goto(link.href, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1000);
      const d = await scrapeFull(page);
      results.projectDetails.push(d);
      console.log('  프로젝트 페이지:', d.title);
    } catch(e) { console.log('  실패:', link.href); }
  }

  const outPath = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/scraped_v4.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\n✅ 저장:', outPath);
  await browser.close();
}

main().catch(console.error);
