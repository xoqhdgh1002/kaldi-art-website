const { chromium } = require('playwright');
const fs = require('fs');

async function login(page, url, username, password) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log(`[${url}] Title: ${title}`);
  if (!title.toLowerCase().includes('login') && !title.toLowerCase().includes('protected')) return true;

  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.waitForTimeout(300);

  // Enter로 제출
  await page.locator('#password').press('Enter');
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 });
  } catch(e) {
    await page.waitForTimeout(3000);
  }

  const newTitle = await page.title();
  console.log('결과:', newTitle, '|', page.url());

  if (newTitle.toLowerCase().includes('login') || newTitle.toLowerCase().includes('protected')) {
    // fetch POST 시도 (args를 하나의 객체로 전달)
    console.log('fetch POST 시도...');
    const result = await page.evaluate(({ u, p, targetUrl }) => {
      const fd = new FormData();
      fd.append('loginSubmit', '1');
      fd.append('username', u);
      fd.append('password', p);
      return fetch(targetUrl, { method: 'POST', body: fd, credentials: 'include' })
        .then(r => ({ status: r.status, url: r.url }))
        .catch(e => ({ error: e.message }));
    }, { u: username, p: password, targetUrl: url });
    console.log('fetch 결과:', result);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  const finalTitle = await page.title();
  console.log('최종:', finalTitle);
  return !finalTitle.toLowerCase().includes('login') && !finalTitle.toLowerCase().includes('protected');
}

async function scrapeAll(page) {
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

  const aOk = await login(page, 'https://kaldiart.com/artists', 'KALDI ARTWORKS', 'Kaldi2425');
  const artists = await scrapeAll(page);
  console.log('\nArtists 로그인:', aOk);
  console.log(artists.text.substring(0, 2000));
  console.log('링크:', artists.links.map(l => l.href).slice(0, 15));

  const pOk = await login(page, 'https://kaldiart.com/exhibitions', 'KALDI ARTWORKS', 'Kaldi2425');
  const projects = await scrapeAll(page);
  console.log('\nProjects 로그인:', pOk);
  console.log(projects.text.substring(0, 2000));
  console.log('링크:', projects.links.map(l => l.href).slice(0, 15));

  const out = { artists, projects };
  fs.writeFileSync('/home/xoqhd/workspace_AI/projects/kaldi-art-website/scraped_v7.json', JSON.stringify(out, null, 2));
  console.log('\n✅ scraped_v7.json 저장');
  await browser.close();
}

main().catch(console.error);
