const { chromium } = require('playwright');
const fs = require('fs');

async function login(page, url, username, password) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log(`[${url}] Title: ${title}`);
  if (!title.toLowerCase().includes('login') && !title.toLowerCase().includes('protected')) return true;

  // 필드 채우기
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.waitForTimeout(300);

  console.log('입력 완료. Enter로 제출...');

  // 두 가지 방법 시도
  try {
    // 방법 1: password 필드에서 Enter
    await page.locator('#password').press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  } catch(e) {
    console.log('Enter 네비게이션 없음, 3초 대기...');
    await page.waitForTimeout(3000);
  }

  const newTitle = await page.title();
  console.log('결과 Title:', newTitle, '| URL:', page.url());

  if (newTitle.toLowerCase().includes('login') || newTitle.toLowerCase().includes('protected')) {
    // 방법 2: fetch로 직접 POST
    console.log('fetch POST 방식 시도...');
    const result = await page.evaluate(async (u, p, pageUrl) => {
      const fd = new FormData();
      fd.append('loginSubmit', '1');
      fd.append('username', u);
      fd.append('password', p);
      const resp = await fetch(pageUrl, { method: 'POST', body: fd, credentials: 'include', redirect: 'follow' });
      return { status: resp.status, url: resp.url, ok: resp.ok };
    }, username, password, url);
    console.log('fetch 결과:', result);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    console.log('reload 후:', await page.title());
  }

  const finalTitle = await page.title();
  return !finalTitle.toLowerCase().includes('login') && !finalTitle.toLowerCase().includes('protected');
}

async function scrape(page) {
  await page.waitForTimeout(500);
  return await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText,
    imgs: Array.from(document.querySelectorAll('img')).map(i => ({ src: i.src, alt: i.alt })),
    links: Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim(), href: a.href }))
      .filter(l => l.href.includes('kaldiart') && !l.href.endsWith('#'))
  }));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // ── Artists ──
  const aOk = await login(page, 'https://kaldiart.com/artists', 'KALDI ARTWORKS', 'Kaldi2425');
  const artists = await scrape(page);
  console.log('\n✓ Artists 로그인:', aOk ? '성공' : '실패');
  console.log(artists.text.substring(0, 3000));
  console.log('이미지:', artists.imgs.slice(0, 5));
  console.log('링크:', artists.links.slice(0, 10));

  // ── Projects ──
  const pOk = await login(page, 'https://kaldiart.com/exhibitions', 'KALDI ARTWORKS', 'Kaldi2425');
  const projects = await scrape(page);
  console.log('\n✓ Projects 로그인:', pOk ? '성공' : '실패');
  console.log(projects.text.substring(0, 3000));
  console.log('이미지:', projects.imgs.slice(0, 5));
  console.log('링크:', projects.links.slice(0, 10));

  // 서브링크 탐색
  const filterLinks = (links, excludeEnds) => [...new Set(
    links.map(l => l.href)
      .filter(h => h.includes('kaldiart.com') && !excludeEnds.some(e => h.endsWith(e)))
  )];

  const aSubLinks = filterLinks(artists.links, ['/artists', '/', '/kaldiart.com']);
  const pSubLinks = filterLinks(projects.links, ['/exhibitions', '/', '/kaldiart.com']);

  console.log('\n아티스트 서브링크:', aSubLinks);
  console.log('프로젝트 서브링크:', pSubLinks);

  const artistDetails = [];
  for (const href of aSubLinks.slice(0, 30)) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);
    const d = await scrape(page);
    artistDetails.push(d);
    console.log('  아티스트:', d.title);
  }

  const projectDetails = [];
  for (const href of pSubLinks.slice(0, 30)) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);
    const d = await scrape(page);
    projectDetails.push(d);
    console.log('  프로젝트:', d.title);
  }

  const out = { artists, projects, artistDetails, projectDetails };
  fs.writeFileSync('/home/xoqhd/workspace_AI/projects/kaldi-art-website/scraped_v6.json', JSON.stringify(out, null, 2));
  console.log('\n✅ scraped_v6.json 저장');
  await browser.close();
}

main().catch(console.error);
