const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeKaldiArt() {
  const browser = await chromium.launch({ headless: true, slowMo: 500 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const results = {
    scrapedAt: new Date().toISOString(),
    baseUrl: 'https://kaldiart.com',
    loginStatus: { success: false },
    pages: {}
  };

  const screenshotDir = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/screenshots';

  // ─── Step 1: /admin 로그인 ─────────────────────────────────────────────
  console.log('=== Step 1: Admin 로그인 시도 ===');
  try {
    const response = await page.goto('https://kaldiart.com/admin', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    console.log('Admin 페이지 URL:', currentUrl);

    await page.screenshot({ path: `${screenshotDir}/admin_login_before.png` });

    // admin_username 필드 채우기
    const usernameField = await page.$('input[name="admin_username"]');
    const passwordField = await page.$('input[name="admin_password"], input[type="password"]');

    console.log('Username 필드 발견:', !!usernameField);
    console.log('Password 필드 발견:', !!passwordField);

    if (usernameField && passwordField) {
      await usernameField.fill('KALDI ARTWORKS');
      await passwordField.fill('Kaldi2425');

      await page.screenshot({ path: `${screenshotDir}/admin_login_filled.png` });

      // 제출
      const submitBtn = await page.$('input[type="submit"]') || await page.$('button[type="submit"]');
      if (submitBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
          submitBtn.click()
        ]);
      } else {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      }

      const afterUrl = page.url();
      console.log('로그인 후 URL:', afterUrl);
      await page.screenshot({ path: `${screenshotDir}/admin_after_login.png` });

      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
      console.log('로그인 후 페이지 텍스트:', pageText.substring(0, 300));

      results.loginStatus.adminUrl = afterUrl;
      results.loginStatus.success = !afterUrl.includes('admin') || afterUrl !== 'https://kaldiart.com/admin';
    }
  } catch(e) {
    console.log('Admin 로그인 오류:', e.message);
  }

  // ─── Step 2: 메인 사이트 로그인 페이지 찾기 ───────────────────────────
  console.log('\n=== Step 2: 메인 사이트 탐색 ===');

  // 타임아웃을 낮추고 domcontentloaded 사용
  const scrapePage = async (key, targetUrl, options = {}) => {
    try {
      console.log(`\n스크래핑: ${key} - ${targetUrl}`);
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      });

      if (!response) {
        return { url: targetUrl, error: 'No response' };
      }

      const status = response.status();
      const finalUrl = page.url();
      console.log(`  상태: ${status}, 최종 URL: ${finalUrl}`);

      // 추가 대기
      await page.waitForTimeout(3000);

      // 스크린샷
      try {
        await page.screenshot({
          path: `${screenshotDir}/scrape_${key}.png`,
          fullPage: true,
          timeout: 10000
        });
        console.log(`  스크린샷 저장됨`);
      } catch(e) {
        console.log(`  스크린샷 오류: ${e.message}`);
      }

      if (status === 404) {
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
        return { url: targetUrl, finalUrl, status, bodyText, error: '404 Not Found' };
      }

      // 전체 내용 추출
      const content = await page.evaluate(() => {
        const title = document.title;
        const h1 = document.querySelector('h1') ? document.querySelector('h1').innerText.trim() : '';
        const h2s = Array.from(document.querySelectorAll('h2')).map(el => el.innerText.trim()).filter(t => t);
        const h3s = Array.from(document.querySelectorAll('h3')).map(el => el.innerText.trim()).filter(t => t);
        const h4s = Array.from(document.querySelectorAll('h4')).map(el => el.innerText.trim()).filter(t => t);

        // 이미지 (배경 이미지 포함)
        const images = [];
        document.querySelectorAll('img').forEach(img => {
          if (img.src && !img.src.startsWith('data:')) {
            images.push({ src: img.src, alt: img.alt, title: img.title });
          }
        });

        // 배경 이미지 찾기
        const bgImages = [];
        document.querySelectorAll('*').forEach(el => {
          const style = window.getComputedStyle(el);
          const bg = style.backgroundImage;
          if (bg && bg !== 'none' && bg.includes('url(')) {
            const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
            if (match) bgImages.push(match[1]);
          }
        });

        // 전체 텍스트
        const bodyText = document.body.innerText;

        // 모든 링크
        const links = Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim().substring(0, 100),
          href: a.href,
          class: a.className.substring(0, 80)
        })).filter(l => l.href && !l.href.startsWith('javascript') && l.href !== '');

        // 네비게이션 구조
        const navLinks = Array.from(document.querySelectorAll('nav a, header a, [class*="nav"] a, [class*="menu"] a')).map(a => ({
          text: a.textContent.trim(),
          href: a.href
        })).filter(l => l.text && l.href);

        // 각 섹션의 상세 내용
        const sections = [];
        document.querySelectorAll('section, article, main, [class*="section"], [class*="block"]').forEach(s => {
          const sectionData = {
            tag: s.tagName,
            id: s.id,
            className: s.className.substring(0, 150),
            text: s.innerText.substring(0, 1000),
            images: Array.from(s.querySelectorAll('img')).map(img => img.src).filter(src => src && !src.startsWith('data:'))
          };
          if (sectionData.text.trim()) sections.push(sectionData);
        });

        // 카드/아이템 데이터
        const itemSelectors = [
          '.card', '[class*="card"]',
          '.item', '[class*="item"]',
          '.project', '[class*="project"]',
          '.artist', '[class*="artist"]',
          '.post', '[class*="post"]',
          'li', '.entry'
        ];

        const cards = [];
        for (const sel of itemSelectors) {
          const elements = document.querySelectorAll(sel);
          if (elements.length > 0 && elements.length < 50) {
            elements.forEach(el => {
              const text = el.innerText.trim();
              if (text.length > 10) {
                cards.push({
                  selector: sel,
                  className: el.className.substring(0, 100),
                  text: text.substring(0, 500),
                  images: Array.from(el.querySelectorAll('img')).map(img => img.src)
                });
              }
            });
            break;
          }
        }

        // 로그인 확인
        const isLoginRequired = bodyText.toLowerCase().includes('login required') ||
                                 bodyText.toLowerCase().includes('sign in to') ||
                                 bodyText.includes('THIS PAGE IS PROTECTED') ||
                                 document.querySelector('input[type="password"]') !== null;

        // 메타 데이터
        const metas = {};
        document.querySelectorAll('meta').forEach(m => {
          if (m.name || m.property) {
            metas[m.name || m.property] = m.content;
          }
        });

        // 모든 텍스트 노드 (숨겨진 데이터 포함)
        const allText = document.documentElement.innerText;

        return {
          title,
          h1,
          h2s,
          h3s,
          h4s,
          images: images.slice(0, 100),
          bgImages: bgImages.slice(0, 30),
          bodyText: bodyText.substring(0, 8000),
          links: links.slice(0, 150),
          navLinks: navLinks.slice(0, 30),
          sections: sections.slice(0, 25),
          cards: cards.slice(0, 50),
          isLoginRequired,
          metas
        };
      });

      console.log(`  제목: ${content.title}`);
      console.log(`  H1: ${content.h1}`);
      console.log(`  H2: ${content.h2s.join(', ')}`);
      console.log(`  이미지 수: ${content.images.length}`);
      console.log(`  배경이미지 수: ${content.bgImages.length}`);
      console.log(`  로그인 필요: ${content.isLoginRequired}`);
      console.log(`  텍스트 일부: ${content.bodyText.substring(0, 200)}`);

      return { url: targetUrl, finalUrl, status, ...content };
    } catch(e) {
      console.log(`  오류: ${e.message}`);
      return { url: targetUrl, error: e.message };
    }
  };

  // ─── Step 3: 공개 페이지들 스크래핑 ────────────────────────────────────
  console.log('\n=== Step 3: 공개 페이지 스크래핑 ===');

  // 먼저 메인 페이지로 네비게이션 구조 파악
  const mainPage = await scrapePage('home', 'https://kaldiart.com');
  results.pages['home'] = mainPage;

  // 메인 페이지에서 발견된 링크들로 추가 페이지 파악
  const siteLinks = (mainPage.links || [])
    .filter(l => l.href.includes('kaldiart.com'))
    .map(l => l.href);
  console.log('\n메인 페이지에서 발견된 내부 링크들:', siteLinks);

  // 알려진 페이지들 스크래핑
  const knownPages = [
    { key: 'about', url: 'https://kaldiart.com/contact' },     // about이 /contact로 매핑된 것 같음
    { key: 'advisory', url: 'https://kaldiart.com/advisory' },
    { key: 'signal_news', url: 'https://kaldiart.com/news' },   // signal이 /news로 매핑
    { key: 'artists', url: 'https://kaldiart.com/artists' },
    { key: 'exhibitions', url: 'https://kaldiart.com/exhibitions' },
  ];

  for (const { key, url } of knownPages) {
    results.pages[key] = await scrapePage(key, url);
  }

  // ─── Step 4: 로그인 후 보호된 페이지 접근 ─────────────────────────────
  console.log('\n=== Step 4: Wix Member Login 시도 ===');

  // Wix 사이트인 경우 Wix 회원 로그인 방식 시도
  // 먼저 artists 페이지의 로그인 폼 확인
  try {
    await page.goto('https://kaldiart.com/artists', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const pageContent = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText,
      html: document.body.innerHTML.substring(0, 5000),
      forms: Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action,
        inputs: Array.from(f.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id }))
      })),
      buttons: Array.from(document.querySelectorAll('button, a')).map(b => ({
        text: b.textContent.trim(),
        href: b.href || '',
        onclick: b.onclick ? 'has onclick' : ''
      })).filter(b => b.text.toLowerCase().includes('log') || b.text.toLowerCase().includes('sign'))
    }));

    console.log('Artists 페이지 로그인 요소:', JSON.stringify(pageContent.forms, null, 2));
    console.log('로그인 버튼들:', JSON.stringify(pageContent.buttons, null, 2));

    await page.screenshot({ path: `${screenshotDir}/artists_login_page.png`, fullPage: true });

    // 로그인 링크나 버튼 찾기
    const loginBtn = await page.$('a:has-text("Log In"), button:has-text("Log In"), a:has-text("Sign In"), a:has-text("login"), [href*="login"]');
    if (loginBtn) {
      console.log('로그인 버튼 발견! 클릭...');
      await loginBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${screenshotDir}/after_login_click.png`, fullPage: true });
      console.log('클릭 후 URL:', page.url());
    }

  } catch(e) {
    console.log('Artists 로그인 페이지 분석 오류:', e.message);
  }

  // ─── Step 5: Wix 로그인 시도 ────────────────────────────────────────
  console.log('\n=== Step 5: Wix 로그인 시도 ===');
  try {
    // Wix 로그인 팝업이나 모달 시도
    await page.goto('https://kaldiart.com/artists', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // 로그인 버튼 클릭
    const loginSelectors = [
      'a:has-text("Log In")',
      'a:has-text("Login")',
      'button:has-text("Log In")',
      'button:has-text("Login")',
      '[data-testid="loginButton"]',
      '.login-button',
      '#loginButton'
    ];

    let clicked = false;
    for (const sel of loginSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          console.log(`로그인 버튼 클릭: ${sel}`);
          await el.click();
          await page.waitForTimeout(3000);
          await page.screenshot({ path: `${screenshotDir}/login_modal.png`, fullPage: true });
          clicked = true;
          break;
        }
      } catch(e) {}
    }

    if (clicked) {
      // 모달/팝업에서 이메일/비밀번호 입력
      const emailSelectors = ['input[type="email"]', 'input[name="email"]', '#email', 'input[placeholder*="email" i]', 'input[placeholder*="username" i]'];
      const passSelectors = ['input[type="password"]', '#password', 'input[placeholder*="password" i]'];

      let emailFilled = false;
      for (const sel of emailSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill('KALDI ARTWORKS');
          emailFilled = true;
          console.log(`이메일/아이디 입력: ${sel}`);
          break;
        }
      }

      for (const sel of passSelectors) {
        const el = await page.$(sel);
        if (el) {
          await el.fill('Kaldi2425');
          console.log(`비밀번호 입력: ${sel}`);
          break;
        }
      }

      if (emailFilled) {
        const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Log In")', 'button:has-text("Sign In")'];
        for (const sel of submitSelectors) {
          const el = await page.$(sel);
          if (el) {
            await el.click();
            await page.waitForTimeout(3000);
            console.log('로그인 제출 후 URL:', page.url());
            await page.screenshot({ path: `${screenshotDir}/after_wix_login.png`, fullPage: true });
            break;
          }
        }
      }
    }

    // 로그인 후 artists 페이지 다시 스크래핑
    await page.goto('https://kaldiart.com/artists', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const artistsAfterLogin = await page.evaluate(() => ({
      title: document.title,
      isLoginRequired: document.body.innerText.toLowerCase().includes('login required') || document.body.innerText.includes('THIS PAGE IS PROTECTED'),
      text: document.body.innerText.substring(0, 2000)
    }));
    console.log('로그인 후 Artists 페이지:', JSON.stringify(artistsAfterLogin, null, 2));

  } catch(e) {
    console.log('Wix 로그인 오류:', e.message);
  }

  // ─── Step 6: 각 페이지의 상세 내용 추출 ───────────────────────────────
  console.log('\n=== Step 6: 공개 페이지 상세 데이터 추출 ===');

  // ADVISORY 페이지 상세
  const advisoryData = results.pages['advisory'] || await scrapePage('advisory', 'https://kaldiart.com/advisory');

  // ABOUT/CONTACT 페이지 상세
  const aboutData = results.pages['about'] || await scrapePage('about', 'https://kaldiart.com/contact');

  // SIGNAL/NEWS 페이지 상세
  const signalData = results.pages['signal_news'] || await scrapePage('signal_news', 'https://kaldiart.com/news');

  // HOME 페이지 상세 - 더 많은 콘텐츠
  await page.goto('https://kaldiart.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(4000);

  const homeDetailedContent = await page.evaluate(() => {
    // 네비게이션 전체 링크
    const allLinks = Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent.trim(),
      href: a.href,
      class: a.className.substring(0, 100)
    })).filter(l => l.href && l.text);

    // 전체 페이지 텍스트
    const fullText = document.body.innerText;

    // 섹션별 분석
    const allElements = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, span, div[class]')).map(el => ({
      tag: el.tagName,
      class: el.className.substring(0, 100),
      text: el.innerText.trim().substring(0, 200)
    })).filter(el => el.text.length > 0);

    return {
      allLinks: allLinks.slice(0, 100),
      fullText: fullText.substring(0, 8000),
      elementSample: allElements.slice(0, 100)
    };
  });

  results.pages['home_detailed'] = homeDetailedContent;

  // ─── Step 7: 어드민 페이지 탐색 ──────────────────────────────────────
  console.log('\n=== Step 7: Admin 페이지 상세 탐색 ===');
  try {
    const adminResponse = await page.goto('https://kaldiart.com/admin', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const adminStatus = adminResponse ? adminResponse.status() : 'unknown';
    const adminUrl = page.url();

    const adminContent = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.substring(0, 3000),
      html: document.body.innerHTML.substring(0, 5000),
      forms: Array.from(document.querySelectorAll('form')).map(f => ({
        action: f.action,
        inputs: Array.from(f.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
        }))
      }))
    }));

    console.log('Admin 페이지 상태:', adminStatus);
    console.log('Admin 페이지 텍스트:', adminContent.text.substring(0, 300));

    // Admin 로그인 재시도 (올바른 셀렉터로)
    const usernameField = await page.$('input[name="admin_username"]');
    const passwordField = await page.$('input[name="admin_password"]');

    if (usernameField && passwordField) {
      console.log('Admin 로그인 재시도...');
      await usernameField.fill('KALDI ARTWORKS');
      await passwordField.fill('Kaldi2425');

      await page.screenshot({ path: `${screenshotDir}/admin_filled.png` });

      const submitBtn = await page.$('input[type="submit"]');
      if (submitBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
          submitBtn.click()
        ]);
        await page.waitForTimeout(3000);

        const postLoginUrl = page.url();
        console.log('Admin 로그인 후 URL:', postLoginUrl);
        await page.screenshot({ path: `${screenshotDir}/admin_logged_in.png`, fullPage: true });

        const postLoginContent = await page.evaluate(() => ({
          title: document.title,
          text: document.body.innerText.substring(0, 5000),
          links: Array.from(document.querySelectorAll('a')).map(a => ({
            text: a.textContent.trim(),
            href: a.href
          })).filter(l => l.text && l.href)
        }));

        results.adminContent = {
          url: postLoginUrl,
          ...postLoginContent
        };
        results.loginStatus.success = true;
        results.loginStatus.adminLoginUrl = postLoginUrl;

        console.log('Admin 로그인 성공!');
        console.log('Admin 텍스트:', postLoginContent.text.substring(0, 500));
        console.log('Admin 링크:', JSON.stringify(postLoginContent.links.slice(0, 20), null, 2));

        // Admin에서 발견된 링크들 방문
        const adminLinks = postLoginContent.links
          .filter(l => l.href.includes('kaldiart.com'))
          .slice(0, 15);

        console.log('\nAdmin에서 발견된 내부 링크들:', adminLinks.map(l => l.href));

        for (const adminLink of adminLinks) {
          try {
            const linkKey = new URL(adminLink.href).pathname.replace(/\//g, '_').replace(/^_/, '') || 'admin_home';
            if (!results.pages[linkKey] && !adminLink.href.includes('/admin')) {
              results.pages[linkKey] = await scrapePage(linkKey, adminLink.href);
            } else if (adminLink.href.includes('/admin')) {
              const adminSubKey = 'admin_' + linkKey;
              if (!results.pages[adminSubKey]) {
                results.pages[adminSubKey] = await scrapePage(adminSubKey, adminLink.href);
              }
            }
          } catch(e) {}
        }
      }
    } else {
      results.adminContent = { url: adminUrl, ...adminContent };
    }
  } catch(e) {
    console.log('Admin 탐색 오류:', e.message);
  }

  await browser.close();

  // 결과 저장
  const outputPath = '/home/xoqhd/workspace_AI/projects/kaldi-art-website/kaldiart_scraped_data.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n=== 완료 ===`);
  console.log(`결과 저장: ${outputPath}`);
  console.log(`총 스크래핑된 페이지 수: ${Object.keys(results.pages).length}`);

  return results;
}

scrapeKaldiArt().catch(console.error);
