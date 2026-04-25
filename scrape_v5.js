const { chromium } = require('playwright');
const fs = require('fs');

async function login(page, url, username, password) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const title = await page.title();
  if (!title.toLowerCase().includes('login') && !title.toLowerCase().includes('protected')) return true;

  console.log(`로그인 시도: ${url}`);

  // username 필드에 직접 타이핑
  await page.locator('#username').waitFor({ state: 'attached', timeout: 5000 });
  await page.locator('#username').clear();
  await page.locator('#username').type(username, { delay: 50 });

  await page.locator('#password').waitFor({ state: 'attached', timeout: 5000 });
  await page.locator('#password').clear();
  await page.locator('#password').type(password, { delay: 50 });

  // 값 확인
  const uVal = await page.locator('#username').inputValue();
  const pVal = await page.locator('#password').inputValue();
  console.log('입력된 username:', uVal);
  console.log('입력된 password:', pVal);

  // submit 버튼 클릭 (force 옵션으로 가시성 무시)
  const submitBtn = page.locator('input[type="submit"], button[type="submit"]');
  await submitBtn.first().click({ force: true });

  await page.waitForTimeout(4000);
  const newTitle = await page.title();
  console.log('결과:', newTitle, page.url());
  return !newTitle.toLowerCase().includes('login') && !newTitle.toLowerCase().includes('protected');
}

async function scrape(page) {
  await page.waitForTimeout(1000);
  const data = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText,
    imgs: Array.from(document.querySelectorAll('img')).map(i => ({ src: i.src, alt: i.alt })),
    links: Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim(), href: a.href }))
      .filter(l => l.href.includes('kaldiart'))
  }));
  return data;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const res = {};

  const aOk = await login(page, 'https://kaldiart.com/artists', 'KALDI ARTWORKS', 'Kaldi2425');
  res.artists = await scrape(page);
  console.log('\nArtists 성공:', aOk);
  console.log(res.artists.text.substring(0, 2000));

  const pOk = await login(page, 'https://kaldiart.com/exhibitions', 'KALDI ARTWORKS', 'Kaldi2425');
  res.projects = await scrape(page);
  console.log('\nProjects 성공:', pOk);
  console.log(res.projects.text.substring(0, 2000));

  // 개별 페이지 링크 탐색
  const aLinks = [...new Set(res.artists.links
    .map(l => l.href)
    .filter(h => h.match(/kaldiart\.com\/[^?#]+/) && !h.endsWith('/artists') && !h.endsWith('#'))
  )];
  console.log('\n아티스트 서브링크:', aLinks);

  const pLinks = [...new Set(res.projects.links
    .map(l => l.href)
    .filter(h => h.match(/kaldiart\.com\/[^?#]+/) && !h.endsWith('/exhibitions') && !h.endsWith('#'))
  )];
  console.log('프로젝트 서브링크:', pLinks);

  res.artistDetails = [];
  for (const href of aLinks.slice(0, 30)) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const d = await scrape(page);
    res.artistDetails.push(d);
    console.log('  아티스트:', d.title, '|', d.text.substring(0, 100));
  }

  res.projectDetails = [];
  for (const href of pLinks.slice(0, 30)) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const d = await scrape(page);
    res.projectDetails.push(d);
    console.log('  프로젝트:', d.title, '|', d.text.substring(0, 100));
  }

  fs.writeFileSync('/home/xoqhd/workspace_AI/projects/kaldi-art-website/scraped_v5.json', JSON.stringify(res, null, 2));
  console.log('\n✅ scraped_v5.json 저장 완료');
  await browser.close();
}

main().catch(console.error);
