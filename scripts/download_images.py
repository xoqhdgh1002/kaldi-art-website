#!/usr/bin/env python3
"""
kaldiart.com 이미지 다운로더
- 웹사이트 크롤링 + content.json URL 추출
- 원본 고화질로 변환 후 다운로드
"""

import asyncio
import json
import os
import re
import time
import urllib.parse
from pathlib import Path

import httpx
from playwright.async_api import async_playwright

SAVE_DIR = Path("/home/xoqhd/workspace_AI/projects/kaldi-art-website/assets/images/scraped")
CONTENT_JSON = Path("/home/xoqhd/workspace_AI/projects/kaldi-art-website/assets/content.json")

PAGES_TO_VISIT = [
    "https://kaldiart.com/",
    "https://kaldiart.com/news/",
    "https://kaldiart.com/blog/",
    "https://kaldiart.com/advisory/",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://kaldiart.com/",
}

# ── URL 변환 ─────────────────────────────────────────────────────────────────

def transform_url(url: str) -> str:
    """저해상도 URL을 고화질 URL로 변환"""
    url = url.strip()
    if not url or url == "https://kaldiart.com/custom_images/1200x630c":
        return ""

    # captcha 이미지는 스킵
    if "captcha.artlogic.net" in url:
        return ""

    # 파일명이 .jpeg이고 basename이 '.' 뿐인 경우 스킵
    basename = url.split("/")[-1]
    if basename in (".", ".jpeg", ""):
        return ""

    # artlogic CDN: transformation 파라미터 교체
    if "static-assets.artlogic.net" in url:
        # 기존 transformation 부분 제거 후 w_2000,f_auto 삽입
        # 패턴: /w_NNN,c_limit,f_auto,fl_lossy,q_auto/ 또는 /c_limit,f_auto,.../ 또는 /w_NNN,h_NNN,.../
        url = re.sub(
            r"/[^/]*(?:w_\d+|c_limit|f_auto|fl_lossy|q_auto|h_\d+)[^/]*/",
            "/w_2000,f_auto/",
            url,
            count=1,
        )
        return url

    # kaldiart.com /custom_images/NNNxNNNc/... → /usr/images/...
    if "kaldiart.com/custom_images/" in url:
        url = re.sub(r"/custom_images/[^/]+/", "/", url)
        return url

    # kaldiart.com /usr/library/... → 그대로
    if "kaldiart.com/usr/" in url:
        return url

    return url


def get_filename(url: str) -> str:
    """URL에서 저장 파일명 추출"""
    parsed = urllib.parse.urlparse(url)
    basename = parsed.path.split("/")[-1]
    # URL decode
    basename = urllib.parse.unquote(basename)
    # 위험 문자 제거
    basename = re.sub(r'[<>:"|?*]', "_", basename)
    return basename if basename else "unknown"


# ── 웹 크롤링 ─────────────────────────────────────────────────────────────────

async def collect_urls_from_page(page, url: str) -> set:
    """단일 페이지에서 이미지 URL 수집"""
    collected = set()
    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)

        # img src 수집
        imgs = await page.query_selector_all("img")
        for img in imgs:
            src = await img.get_attribute("src") or ""
            data_src = await img.get_attribute("data-src") or ""
            srcset = await img.get_attribute("srcset") or ""
            for s in [src, data_src]:
                if s:
                    full = urllib.parse.urljoin(url, s)
                    collected.add(full)
            # srcset 파싱
            for part in srcset.split(","):
                s = part.strip().split()[0]
                if s:
                    full = urllib.parse.urljoin(url, s)
                    collected.add(full)

        # background-image in style
        elements = await page.query_selector_all("[style*='background-image']")
        for el in elements:
            style = await el.get_attribute("style") or ""
            matches = re.findall(r"url\(['\"]?([^'\")\s]+)['\"]?\)", style)
            for m in matches:
                full = urllib.parse.urljoin(url, m)
                collected.add(full)

        # picture > source srcset
        sources = await page.query_selector_all("source")
        for src_el in sources:
            srcset = await src_el.get_attribute("srcset") or ""
            for part in srcset.split(","):
                s = part.strip().split()[0]
                if s:
                    full = urllib.parse.urljoin(url, s)
                    collected.add(full)

    except Exception as e:
        print(f"  [WARN] 페이지 로드 실패 {url}: {e}")

    return collected


async def collect_detail_page_urls(browser, list_page_url: str) -> tuple[set, list]:
    """목록 페이지에서 상세 페이지 링크 수집 후 각 상세 페이지 크롤링"""
    all_urls = set()
    detail_links = []

    context = await browser.new_context(
        user_agent=HEADERS["User-Agent"],
        viewport={"width": 1920, "height": 1080},
    )
    page = await context.new_page()

    try:
        print(f"\n[크롤링] {list_page_url}")
        urls = await collect_urls_from_page(page, list_page_url)
        all_urls.update(urls)

        # 상세 페이지 링크 수집
        links = await page.query_selector_all("a[href]")
        for link in links:
            href = await link.get_attribute("href") or ""
            full = urllib.parse.urljoin(list_page_url, href)
            # 같은 도메인 하위 페이지만
            if full.startswith(list_page_url) and full != list_page_url:
                detail_links.append(full)

        detail_links = list(set(detail_links))
        print(f"  상세 페이지 {len(detail_links)}개 발견")

        for detail_url in detail_links:
            print(f"  [상세] {detail_url}")
            urls = await collect_urls_from_page(page, detail_url)
            all_urls.update(urls)
            await asyncio.sleep(0.5)

    finally:
        await context.close()

    return all_urls, detail_links


async def crawl_all_pages() -> set:
    """모든 페이지 크롤링"""
    all_image_urls = set()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        try:
            for base_url in PAGES_TO_VISIT:
                if base_url in ("https://kaldiart.com/news/", "https://kaldiart.com/blog/"):
                    urls, _ = await collect_detail_page_urls(browser, base_url)
                else:
                    context = await browser.new_context(
                        user_agent=HEADERS["User-Agent"],
                        viewport={"width": 1920, "height": 1080},
                    )
                    page = await context.new_page()
                    print(f"\n[크롤링] {base_url}")
                    urls = await collect_urls_from_page(page, base_url)
                    await context.close()

                all_image_urls.update(urls)
                print(f"  수집된 URL: {len(urls)}개")
        finally:
            await browser.close()

    return all_image_urls


# ── content.json URL 수집 ────────────────────────────────────────────────────

def collect_from_content_json() -> set:
    """content.json에서 이미지 URL 수집"""
    urls = set()
    with open(CONTENT_JSON) as f:
        data = json.load(f)

    for section in ["signal", "journal"]:
        for item in data.get(section, []):
            cover = item.get("coverImage", "")
            if cover:
                urls.add(cover)
            for img in item.get("images", []):
                if img:
                    urls.add(img)

    return urls


# ── 다운로드 ─────────────────────────────────────────────────────────────────

def resolve_filename_conflict(save_dir: Path, filename: str, url: str) -> Path:
    """중복 파일명 처리: URL이 같으면 덮어쓰기, 다르면 _N 접미사"""
    target = save_dir / filename
    if not target.exists():
        return target
    # 동일 URL이면 그냥 덮어쓰기
    return target


async def download_images(urls: set) -> dict:
    """변환된 URL로 이미지 다운로드"""
    results = {"success": [], "skip": [], "error": []}
    SAVE_DIR.mkdir(parents=True, exist_ok=True)

    # URL 변환
    url_map = {}  # transformed_url -> filename
    for url in urls:
        transformed = transform_url(url)
        if not transformed:
            results["skip"].append(url)
            continue
        filename = get_filename(transformed)
        if not filename or filename == "unknown":
            results["skip"].append(url)
            continue
        url_map[transformed] = filename

    print(f"\n총 다운로드 대상: {len(url_map)}개")

    async with httpx.AsyncClient(
        headers=HEADERS,
        timeout=60,
        follow_redirects=True,
        verify=False,
    ) as client:
        for i, (url, filename) in enumerate(url_map.items(), 1):
            target = SAVE_DIR / filename
            try:
                print(f"  [{i}/{len(url_map)}] {filename[:60]}")
                resp = await client.get(url)
                if resp.status_code == 200:
                    content_type = resp.headers.get("content-type", "")
                    if "image" in content_type or "octet-stream" in content_type:
                        target.write_bytes(resp.content)
                        size_kb = len(resp.content) / 1024
                        results["success"].append((filename, size_kb, url))
                        print(f"    OK {size_kb:.1f} KB")
                    else:
                        print(f"    SKIP (not image: {content_type})")
                        results["skip"].append(url)
                else:
                    print(f"    ERROR HTTP {resp.status_code}")
                    results["error"].append((url, f"HTTP {resp.status_code}"))
            except Exception as e:
                print(f"    ERROR {e}")
                results["error"].append((url, str(e)))

            # 서버 과부하 방지
            if i % 10 == 0:
                await asyncio.sleep(1)
            else:
                await asyncio.sleep(0.2)

    return results


# ── 메인 ─────────────────────────────────────────────────────────────────────

async def main():
    print("=" * 60)
    print("kaldiart.com 이미지 다운로더")
    print("=" * 60)

    # 1. 웹사이트 크롤링
    print("\n[1단계] 웹사이트 크롤링...")
    crawled_urls = await crawl_all_pages()
    print(f"크롤링으로 수집된 총 URL: {len(crawled_urls)}개")

    # 2. content.json URL 수집
    print("\n[2단계] content.json URL 수집...")
    json_urls = collect_from_content_json()
    print(f"content.json에서 수집된 URL: {len(json_urls)}개")

    # 3. 합치기
    all_urls = crawled_urls | json_urls
    # kaldiart.com 또는 artlogic 이미지만
    filtered = {
        u for u in all_urls
        if ("kaldiart.com" in u or "artlogic.net" in u)
        and any(u.lower().endswith(ext) for ext in
                [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"])
        or ("kaldiart.com" in u or "static-assets.artlogic.net" in u)
        and "/usr/images/" in u or "/usr/library/" in u
    }
    # 좀 더 넓게: artlogic CDN이나 kaldiart.com usr 경로
    filtered2 = set()
    for u in all_urls:
        if not u:
            continue
        if "captcha.artlogic.net" in u:
            continue
        if "static-assets.artlogic.net" in u and ("/usr/images/" in u or "/usr/library/" in u):
            filtered2.add(u)
        elif "kaldiart.com" in u and ("/usr/images/" in u or "/usr/library/" in u or "/custom_images/" in u):
            filtered2.add(u)

    print(f"필터링 후 대상: {len(filtered2)}개")

    # 4. 다운로드
    print("\n[3단계] 이미지 다운로드...")
    results = await download_images(filtered2)

    # 5. 결과 보고
    print("\n" + "=" * 60)
    print("완료 보고")
    print("=" * 60)
    print(f"성공: {len(results['success'])}개")
    print(f"스킵: {len(results['skip'])}개")
    print(f"에러: {len(results['error'])}개")

    print("\n[저장된 파일 목록 (크기 순 상위 50개)]")
    sorted_success = sorted(results["success"], key=lambda x: x[1], reverse=True)
    for filename, size_kb, url in sorted_success[:50]:
        print(f"  {filename:<70} {size_kb:>8.1f} KB")

    if results["error"]:
        print("\n[에러 목록]")
        for url, err in results["error"][:20]:
            print(f"  {url[:80]}: {err}")

    # 실제 저장된 파일 목록 (디스크 기준)
    print("\n[실제 저장 폴더 파일 수]")
    all_files = list(SAVE_DIR.glob("*"))
    total_size = sum(f.stat().st_size for f in all_files if f.is_file())
    print(f"  파일 수: {len(all_files)}개")
    print(f"  총 크기: {total_size / 1024 / 1024:.1f} MB")
    print(f"  저장 경로: {SAVE_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
