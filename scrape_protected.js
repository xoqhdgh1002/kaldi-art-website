const { chromium } = require('playwright');
const fs = require('fs');

async function scrape() {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  const page = await context.newPage();
  const results = {};

  // ── 1. Artists 로그인 ──────────────────────────────────────────────
  console.log('\n=== Artists 페이지 ===');
  await page.goto('https://kaldiart.com/artists', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('URL:', page.url());
  console.log('Title:', await page.title());
  await page.screenshot({ path: '/tmp/artists_before.png', fullPage: true });

  // 비밀번호 필드 찾기
  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) {
    console.log('비밀번호 필드 발견');
    await passwordInput.fill('Kaldi2425');
    await page.waitForTimeout(500);

    // submit 버튼 또는 enter
    const submitBtn = await page.$('input[type="submit"], button[type="submit"], .submit, button');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passwordInput.press('Enter');
    }
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/artists_after_login.png', fullPage: true });
    console.log('로그인 후 URL:', page.url());
    console.log('로그인 후 Title:', await page.title());
  } else {
    // ID/PW 필드 모두 있는 경우
    const allInputs = await page.$$('input');
    console.log('입력 필드 수:', allInputs.length);
    for (const inp of allInputs) {
      const type = await inp.getAttribute('type');
      const name = await inp.getAttribute('name');
      const placeholder = await inp.getAttribute('placeholder');
      console.log('  field:', type, name, placeholder);
    }
  }

  // 페이지 내용 수집
  const artistsContent = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      h1: document.querySelector('h1')?.textContent?.trim(),
      bodyText: document.body.innerText.substring(0, 5000),
      allText: document.body.innerText,
      // 아티스트 항목들
      items: Array.from(document.querySelectorAll(
        '.artist, .artist-item, .artist-name, [class*="artist"], li, .entry, .work-item'
      )).map(el => ({
        tag: el.tagName,
        class: el.className,
        text: el.textContent.trim().substring(0, 200),
        href: el.querySelector('a')?.href
      })).filter(i => i.text.length > 2).slice(0, 100),
      images: Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.src,
        alt: img.alt
      })),
      links: Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().substring(0, 100),
        href: a.href
      })).filter(l => l.href.includes('kaldiart.com'))
    };
  });
  results.artists = artistsContent;
  console.log('Artists bodyText preview:', artistsContent.bodyText.substring(0, 500));

  // ── 2. Projects (exhibitions) 로그인 ──────────────────────────────
  console.log('\n=== Projects (exhibitions) 페이지 ===');
  await page.goto('https://kaldiart.com/exhibitions', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/projects_before.png', fullPage: true });
  console.log('URL:', page.url());
  console.log('Title:', await page.title());

  const pwInput2 = await page.$('input[type="password"]');
  if (pwInput2) {
    console.log('비밀번호 필드 발견');
    await pwInput2.fill('Kaldi2425');
    await page.waitForTimeout(500);
    const btn2 = await page.$('input[type="submit"], button[type="submit"], button');
    if (btn2) await btn2.click();
    else await pwInput2.press('Enter');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '/tmp/projects_after_login.png', fullPage: true });
    console.log('로그인 후 URL:', page.url());
    console.log('로그인 후 Title:', await page.title());
  }

  const projectsContent = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      h1: document.querySelector('h1')?.textContent?.trim(),
      bodyText: document.body.innerText.substring(0, 5000),
      allText: document.body.innerText,
      items: Array.from(document.querySelectorAll(
        '.exhibition, .project, .work, [class*="exhibition"], [class*="project"], article, .entry'
      )).map(el => ({
        tag: el.tagName,
        class: el.className,
        text: el.textContent.trim().substring(0, 300),
        href: el.querySelector('a')?.href,
        images: Array.from(el.querySelectorAll('img')).map(i => i.src)
      })).filter(i => i.text.length > 5).slice(0, 100),
      images: Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.src,
        alt: img.alt
      })),
      links: Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().substring(0, 100),
        href: a.href
      })).filter(l => l.href.includes('kaldiart.com'))
    };
  });
  results.projects = projectsContent;
  console.log('Projects bodyText preview:', projectsContent.bodyText.substring(0, 500));

  // ── 저장 ───────────────────────────────────────────────────────────
  fs.writeFileSync(
    '/home/xoqhd/workspace_AI/projects/kaldi-art-website/scraped_protected.json',
    JSON.stringify(results, null, 2)
  );
  console.log('\n✅ 저장 완료: scraped_protected.json');

  await browser.close();
}

scrape().catch(console.error);
