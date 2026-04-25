const { chromium } = require('playwright');
const fs = require('fs');

async function loginAndScrape(page, url, password) {
  console.log(`\n접속: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log('Title:', title);

  // 로그인 페이지인지 확인
  const isLoginPage = title.includes('Login') || title.includes('login') || title.includes('protected');
  if (!isLoginPage) {
    console.log('→ 로그인 불필요');
    return false;
  }

  // 페이지 HTML 일부 확인
  const formHtml = await page.evaluate(() => {
    const form = document.querySelector('form');
    return form ? form.outerHTML.substring(0, 1000) : document.body.innerHTML.substring(0, 2000);
  });
  console.log('Form HTML:', formHtml.substring(0, 500));
  await page.screenshot({ path: `/tmp/login_${Date.now()}.png` });

  // 비밀번호 입력
  const pwInput = await page.$('input[type="password"], input[name*="pass"], input[name*="password"]');
  if (pwInput) {
    await pwInput.click({ force: true });
    await pwInput.fill(password);
    await page.waitForTimeout(500);

    // Enter 키로 제출
    await pwInput.press('Enter');
    await page.waitForTimeout(3000);

    const newTitle = await page.title();
    console.log('제출 후 Title:', newTitle);
    console.log('제출 후 URL:', page.url());
    await page.screenshot({ path: `/tmp/after_login_${Date.now()}.png` });
    return !newTitle.includes('Login') && !newTitle.includes('login');
  }

  // form action 기반 직접 POST 시도
  const actionUrl = await page.evaluate(() => {
    const form = document.querySelector('form');
    return form ? form.action : null;
  });
  console.log('Form action:', actionUrl);
  return false;
}

async function scrapePage(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
    const getAll = (sel) => Array.from(document.querySelectorAll(sel)).map(el => el.textContent.trim());

    // 이미지 수집
    const images = Array.from(document.querySelectorAll('img')).map(img => ({
      src: img.src || img.getAttribute('data-src'),
      alt: img.alt,
      title: img.title
    })).filter(i => i.src && !i.src.includes('data:'));

    // 링크 수집
    const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: a.textContent.trim(),
      href: a.href
    })).filter(l => l.href.includes('kaldiart.com') && l.text.length > 0);

    // 전체 텍스트
    const bodyText = document.body.innerText;

    // 구조적 항목 수집 (아티스트, 프로젝트 등)
    const items = [];
    const selectors = [
      'article', '.item', '.entry', '.work', '.artist',
      '.exhibition', '.project', '[class*="item"]',
      '[class*="entry"]', '[class*="work"]', '[class*="artist"]',
      'li', '.card', '.post'
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0 && els.length < 200) {
        els.forEach(el => {
          const t = el.textContent.trim();
          if (t.length > 5 && t.length < 500) {
            items.push({
              selector: sel,
              class: el.className,
              text: t,
              imgSrcs: Array.from(el.querySelectorAll('img')).map(i => i.src),
              href: el.querySelector('a')?.href
            });
          }
        });
        if (items.length > 0) break;
      }
    }

    return {
      title: document.title,
      url: window.location.href,
      h1: getText('h1'),
      h2s: getAll('h2'),
      h3s: getAll('h3'),
      bodyText,
      images,
      links,
      items: items.slice(0, 150)
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const results = {};

  // ── Artists ──────────────────────────────────────────
  const artistsLoggedIn = await loginAndScrape(page, 'https://kaldiart.com/artists', 'Kaldi2425');
  results.artists = await scrapePage(page, page.url());
  console.log('\nArtists 로그인 성공:', artistsLoggedIn);
  console.log('Artists bodyText (첫 1000자):', results.artists.bodyText.substring(0, 1000));

  // ── Projects (exhibitions) ───────────────────────────
  const projectsLoggedIn = await loginAndScrape(page, 'https://kaldiart.com/exhibitions', 'Kaldi2425');
  results.projects = await scrapePage(page, page.url());
  console.log('\nProjects 로그인 성공:', projectsLoggedIn);
  console.log('Projects bodyText (첫 1000자):', results.projects.bodyText.substring(0, 1000));

  // ── 개별 항목 링크 탐색 ──────────────────────────────
  const artistLinks = results.artists.links.filter(l =>
    l.href.includes('/artist/') || l.href.includes('/artists/')
  );
  console.log('\nArtist links found:', artistLinks.length, artistLinks.slice(0,5));

  const projectLinks = results.projects.links.filter(l =>
    l.href.includes('/exhibition/') || l.href.includes('/project/') || l.href.includes('/exhibitions/')
  );
  console.log('Project links found:', projectLinks.length, projectLinks.slice(0,5));

  // 개별 아티스트 페이지 스크래핑 (최대 20개)
  results.artistDetails = [];
  for (const link of artistLinks.slice(0, 20)) {
    try {
      const detail = await scrapePage(page, link.href);
      results.artistDetails.push({ url: link.href, ...detail });
      console.log('  아티스트:', detail.h1 || detail.title);
    } catch (e) {
      console.log('  실패:', link.href, e.message);
    }
  }

  // 개별 프로젝트 페이지 스크래핑 (최대 20개)
  results.projectDetails = [];
  for (const link of projectLinks.slice(0, 20)) {
    try {
      const detail = await scrapePage(page, link.href);
      results.projectDetails.push({ url: link.href, ...detail });
      console.log('  프로젝트:', detail.h1 || detail.title);
    } catch (e) {
      console.log('  실패:', link.href, e.message);
    }
  }

  fs.writeFileSync(
    '/home/xoqhd/workspace_AI/projects/kaldi-art-website/scraped_protected_v3.json',
    JSON.stringify(results, null, 2)
  );
  console.log('\n✅ 저장 완료: scraped_protected_v3.json');
  await browser.close();
}

main().catch(console.error);
