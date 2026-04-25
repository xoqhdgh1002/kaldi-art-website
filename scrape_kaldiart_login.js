const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeKaldiArt() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const results = {
    scrapedAt: new Date().toISOString(),
    baseUrl: 'https://kaldiart.com',
    pages: {}
  };

  // ─── Step 1: 메인 페이지 접속 및 네비게이션 구조 파악 ─────────────────────
  console.log('=== Step 1: 메인 페이지 접속 ===');
  try {
    await page.goto('https://kaldiart.com', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    const url = page.url();
    console.log(`메인 페이지 URL: ${url}`);
    console.log(`메인 페이지 제목: ${title}`);

    // 네비게이션 링크 수집
    const navLinks = await page.evaluate(() => {
      const links = [];
      const navElements = document.querySelectorAll('nav a, header a, .nav a, .navigation a, .menu a');
      navElements.forEach(a => {
        if (a.href && !a.href.startsWith('javascript')) {
          links.push({
            text: a.textContent.trim(),
            href: a.href,
            pathname: new URL(a.href).pathname
          });
        }
      });
      return [...new Map(links.map(l => [l.href, l])).values()];
    });
    console.log('네비게이션 링크:', JSON.stringify(navLinks, null, 2));

    // 전체 링크 수집
    const allLinks = await page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a').forEach(a => {
        if (a.href && a.href.includes('kaldiart.com')) {
          links.push({
            text: a.textContent.trim().substring(0, 50),
            href: a.href
          });
        }
      });
      return [...new Map(links.map(l => [l.href, l])).values()];
    });

    // 메인 페이지 텍스트 내용
    const mainContent = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return bodyText.substring(0, 3000);
    });

    results.pages['home'] = {
      url,
      title,
      navLinks,
      allLinks,
      textContent: mainContent
    };

    // 스크린샷
    await page.screenshot({ path: '/home/xoqhd/workspace_AI/projects/kaldi-art-website/screenshots/scrape_home.png', fullPage: true });
    console.log('메인 페이지 스크린샷 저장됨');

  } catch (e) {
    console.error('메인 페이지 오류:', e.message);
    results.pages['home'] = { error: e.message };
  }

  // ─── Step 2: 로그인 페이지 찾기 ─────────────────────────────────────────
  console.log('\n=== Step 2: 로그인 시도 ===');
  const loginUrls = [
    'https://kaldiart.com/login',
    'https://kaldiart.com/signin',
    'https://kaldiart.com/members',
    'https://kaldiart.com/member/login',
    'https://kaldiart.com/account/login',
    'https://kaldiart.com/wp-login.php',
    'https://kaldiart.com/admin',
  ];

  let loginSuccess = false;
  let loginPageUrl = null;

  // 먼저 메인 페이지에서 로그인 버튼/링크 찾기
  try {
    await page.goto('https://kaldiart.com', { waitUntil: 'networkidle', timeout: 30000 });

    const loginLink = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      const loginLinks = allLinks.filter(a => {
        const text = a.textContent.toLowerCase().trim();
        const href = a.href.toLowerCase();
        return text.includes('login') || text.includes('sign in') || text.includes('로그인') ||
               href.includes('login') || href.includes('signin') || href.includes('member');
      });
      return loginLinks.map(a => ({ text: a.textContent.trim(), href: a.href }));
    });
    console.log('로그인 관련 링크:', JSON.stringify(loginLink, null, 2));

    if (loginLink.length > 0) {
      loginPageUrl = loginLink[0].href;
    }
  } catch(e) {
    console.log('메인 페이지에서 로그인 링크 탐색 오류:', e.message);
  }

  // 로그인 시도
  const tryLogin = async (url) => {
    try {
      console.log(`로그인 페이지 시도: ${url}`);
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      if (!response || response.status() >= 400) return false;

      const currentUrl = page.url();
      console.log(`현재 URL: ${currentUrl}`);

      await page.screenshot({ path: `/home/xoqhd/workspace_AI/projects/kaldi-art-website/screenshots/login_attempt_${url.replace(/[^a-z0-9]/gi,'_')}.png` });

      // 폼 요소 찾기
      const formInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const forms = Array.from(document.querySelectorAll('form'));
        return {
          inputs: inputs.map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder })),
          forms: forms.map(f => ({ action: f.action, method: f.method })),
          pageText: document.body.innerText.substring(0, 500)
        };
      });
      console.log('폼 정보:', JSON.stringify(formInfo, null, 2));

      // 사용자명/이메일 필드 찾기
      const usernameSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]',
                                  'input[name="user"]', 'input[id="username"]', 'input[id="email"]',
                                  'input[name="log"]', 'input[autocomplete="username"]'];
      const passwordSelectors = ['input[name="password"]', 'input[type="password"]', 'input[id="password"]',
                                  'input[name="pwd"]', 'input[autocomplete="current-password"]'];

      let usernameField = null;
      let passwordField = null;

      for (const sel of usernameSelectors) {
        const el = await page.$(sel);
        if (el) { usernameField = sel; break; }
      }
      for (const sel of passwordSelectors) {
        const el = await page.$(sel);
        if (el) { passwordField = sel; break; }
      }

      console.log(`사용자명 필드: ${usernameField}, 비밀번호 필드: ${passwordField}`);

      if (!usernameField || !passwordField) {
        console.log('로그인 폼을 찾지 못함');
        return false;
      }

      await page.fill(usernameField, 'KALDI ARTWORKS');
      await page.fill(passwordField, 'Kaldi2425');

      // 제출 버튼 찾기
      const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Login")',
                                'button:has-text("Sign In")', 'button:has-text("로그인")', '.login-button',
                                '#submit', '#login-button'];

      let submitBtn = null;
      for (const sel of submitSelectors) {
        const el = await page.$(sel);
        if (el) { submitBtn = sel; break; }
      }

      if (!submitBtn) {
        // 첫 번째 버튼 시도
        submitBtn = 'button';
      }

      console.log(`제출 버튼: ${submitBtn}`);

      // 폼 제출
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
        page.click(submitBtn)
      ]);

      await page.waitForTimeout(2000);

      const afterUrl = page.url();
      console.log(`로그인 후 URL: ${afterUrl}`);

      await page.screenshot({ path: '/home/xoqhd/workspace_AI/projects/kaldi-art-website/screenshots/after_login.png' });

      // 로그인 성공 판단
      const isLoggedIn = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('logout') || text.includes('sign out') || text.includes('로그아웃') ||
               text.includes('dashboard') || text.includes('my account') || text.includes('profile');
      });

      if (isLoggedIn || (afterUrl !== url && !afterUrl.includes('login') && !afterUrl.includes('signin'))) {
        console.log('로그인 성공!');
        return true;
      }
      return false;
    } catch(e) {
      console.log(`URL ${url} 오류: ${e.message}`);
      return false;
    }
  };

  // 로그인 시도
  const loginAttemptUrls = loginPageUrl ? [loginPageUrl, ...loginUrls] : loginUrls;
  for (const url of loginAttemptUrls) {
    if (await tryLogin(url)) {
      loginSuccess = true;
      loginPageUrl = url;
      break;
    }
  }

  results.loginStatus = { success: loginSuccess, loginPageUrl };
  console.log(`\n로그인 상태: ${loginSuccess ? '성공' : '실패'}`);

  // ─── Step 3: 주요 페이지들 스크래핑 ────────────────────────────────────
  console.log('\n=== Step 3: 주요 페이지 스크래핑 ===');

  const pagesToScrape = [
    { key: 'projects', url: 'https://kaldiart.com/projects' },
    { key: 'artists', url: 'https://kaldiart.com/artists' },
    { key: 'about', url: 'https://kaldiart.com/about' },
    { key: 'journal', url: 'https://kaldiart.com/journal' },
    { key: 'signal', url: 'https://kaldiart.com/signal' },
    { key: 'advisory', url: 'https://kaldiart.com/advisory' },
    { key: 'contact', url: 'https://kaldiart.com/contact' },
    { key: 'members', url: 'https://kaldiart.com/members' },
    { key: 'member_area', url: 'https://kaldiart.com/member-area' },
    { key: 'dashboard', url: 'https://kaldiart.com/dashboard' },
    { key: 'gallery', url: 'https://kaldiart.com/gallery' },
    { key: 'exhibitions', url: 'https://kaldiart.com/exhibitions' },
    { key: 'news', url: 'https://kaldiart.com/news' },
  ];

  const scrapePage = async (key, targetUrl) => {
    try {
      console.log(`\n스크래핑: ${key} - ${targetUrl}`);
      const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });

      if (!response) {
        console.log(`${key}: 응답 없음`);
        return { url: targetUrl, error: 'No response' };
      }

      const status = response.status();
      const finalUrl = page.url();
      console.log(`  상태: ${status}, 최종 URL: ${finalUrl}`);

      if (status === 404) {
        return { url: targetUrl, finalUrl, status, error: '404 Not Found' };
      }

      await page.waitForTimeout(2000);

      // 스크린샷
      try {
        await page.screenshot({
          path: `/home/xoqhd/workspace_AI/projects/kaldi-art-website/screenshots/scrape_${key}.png`,
          fullPage: true,
          timeout: 10000
        });
      } catch(e) {
        console.log(`  스크린샷 오류: ${e.message}`);
      }

      // 페이지 내용 추출
      const content = await page.evaluate(() => {
        const getTextContent = (el) => el ? el.innerText.trim() : '';

        // 제목
        const title = document.title;
        const h1 = getTextContent(document.querySelector('h1'));
        const h2s = Array.from(document.querySelectorAll('h2')).map(el => el.innerText.trim());
        const h3s = Array.from(document.querySelectorAll('h3')).map(el => el.innerText.trim());

        // 이미지
        const images = Array.from(document.querySelectorAll('img')).map(img => ({
          src: img.src,
          alt: img.alt,
          title: img.title,
          width: img.naturalWidth,
          height: img.naturalHeight
        })).filter(img => img.src && !img.src.includes('data:'));

        // 전체 텍스트
        const bodyText = document.body.innerText;

        // 링크
        const links = Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim().substring(0, 100),
          href: a.href
        })).filter(l => l.href && !l.href.startsWith('javascript'));

        // 섹션 구조
        const sections = Array.from(document.querySelectorAll('section, article, .section, [class*="section"]')).map(s => ({
          tag: s.tagName,
          className: s.className.substring(0, 100),
          id: s.id,
          text: s.innerText.substring(0, 500)
        }));

        // 카드/아이템 데이터 (프로젝트, 아티스트 등)
        const cards = Array.from(document.querySelectorAll('.card, [class*="card"], .item, [class*="item"], .project, [class*="project"], .artist, [class*="artist"]')).map(c => ({
          className: c.className.substring(0, 100),
          text: c.innerText.substring(0, 300),
          images: Array.from(c.querySelectorAll('img')).map(img => img.src)
        }));

        // 로그인 관련 확인
        const isLoginRequired = bodyText.toLowerCase().includes('login') ||
                                 bodyText.toLowerCase().includes('sign in') ||
                                 bodyText.toLowerCase().includes('로그인') ||
                                 document.querySelector('form input[type="password"]') !== null;

        // 메타 태그
        const metas = Array.from(document.querySelectorAll('meta')).map(m => ({
          name: m.name || m.property,
          content: m.content
        })).filter(m => m.name && m.content);

        return {
          title,
          h1,
          h2s: h2s.slice(0, 20),
          h3s: h3s.slice(0, 20),
          images: images.slice(0, 50),
          bodyText: bodyText.substring(0, 5000),
          links: links.slice(0, 100),
          sections: sections.slice(0, 20),
          cards: cards.slice(0, 30),
          isLoginRequired,
          metas
        };
      });

      console.log(`  제목: ${content.title}`);
      console.log(`  H1: ${content.h1}`);
      console.log(`  이미지 수: ${content.images.length}`);
      console.log(`  카드/아이템 수: ${content.cards.length}`);
      console.log(`  로그인 필요: ${content.isLoginRequired}`);

      return {
        url: targetUrl,
        finalUrl,
        status,
        ...content
      };
    } catch(e) {
      console.log(`  오류: ${e.message}`);
      return { url: targetUrl, error: e.message };
    }
  };

  for (const { key, url: pageUrl } of pagesToScrape) {
    results.pages[key] = await scrapePage(key, pageUrl);
  }

  // ─── Step 4: 동적으로 발견된 링크도 스크래핑 ─────────────────────────────
  console.log('\n=== Step 4: 추가 페이지 탐색 ===');

  // 메인 페이지에서 발견된 모든 kaldiart.com 링크 다시 확인
  const discoveredLinks = results.pages['home']?.allLinks || [];
  const additionalUrls = new Set();

  for (const link of discoveredLinks) {
    try {
      const linkUrl = new URL(link.href);
      if (linkUrl.hostname === 'kaldiart.com' || linkUrl.hostname === 'www.kaldiart.com') {
        const path = linkUrl.pathname;
        if (path !== '/' && path !== '' && !pagesToScrape.some(p => p.url.includes(path))) {
          additionalUrls.add(link.href);
        }
      }
    } catch(e) {}
  }

  console.log('추가 발견된 URL들:', Array.from(additionalUrls));

  for (const additionalUrl of Array.from(additionalUrls).slice(0, 10)) {
    try {
      const urlObj = new URL(additionalUrl);
      const key = urlObj.pathname.replace(/\//g, '_').replace(/^_/, '') || 'unknown';
      if (!results.pages[key]) {
        results.pages[key] = await scrapePage(key, additionalUrl);
      }
    } catch(e) {}
  }

  // ─── Step 5: Wix/Squarespace/기타 CMS 특화 스크래핑 ──────────────────
  console.log('\n=== Step 5: CMS/플랫폼 확인 ===');
  try {
    await page.goto('https://kaldiart.com', { waitUntil: 'networkidle', timeout: 30000 });
    const platformInfo = await page.evaluate(() => {
      const html = document.documentElement.outerHTML.substring(0, 5000);
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
      const isWix = html.includes('wix.com') || html.includes('wixstatic') || html.includes('wixsite');
      const isSquarespace = html.includes('squarespace') || html.includes('sqsp');
      const isWordPress = html.includes('wp-content') || html.includes('wordpress');
      const isWeebly = html.includes('weebly') || html.includes('editmysite');
      const isShopify = html.includes('shopify') || html.includes('myshopify');
      const isWebflow = html.includes('webflow') || html.includes('wf-');

      return {
        isWix, isSquarespace, isWordPress, isWeebly, isShopify, isWebflow,
        scripts: scripts.slice(0, 10),
        htmlSnippet: html.substring(0, 2000)
      };
    });

    results.platformInfo = platformInfo;
    console.log('플랫폼 정보:', JSON.stringify({
      isWix: platformInfo.isWix,
      isSquarespace: platformInfo.isSquarespace,
      isWordPress: platformInfo.isWordPress,
      isWebflow: platformInfo.isWebflow
    }, null, 2));
  } catch(e) {
    console.log('플랫폼 확인 오류:', e.message);
  }

  await browser.close();

  // 결과 저장
  const outputPath = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/kaldiart_scraped_data.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n=== 완료 ===`);
  console.log(`결과 저장: ${outputPath}`);

  return results;
}

scrapeKaldiArt().catch(console.error);
