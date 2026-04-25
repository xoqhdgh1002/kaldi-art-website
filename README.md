# KALDI ART Website

KALDI ART 공식 웹사이트 — 한국 현대미술 어드바이저리 및 에디토리얼 플랫폼.

## 주요 기능

- 7개 페이지 싱글 페이지 애플리케이션 (SPA)
- 반응형 디자인 (데스크탑 / 태블릿 / 모바일)
- kaldiart.com 스타일 기반 Ultra-minimal Editorial 디자인
- 순수 HTML/CSS/JS — 프레임워크 불필요

## 페이지 구성

| 페이지 | 경로 | 내용 |
|--------|------|------|
| Home | `/` | 히어로 + 에디토리얼 섹션 |
| Advisory | `#advisory` | 어드바이저리 서비스 3종 |
| Projects | `#projects` | 프로젝트 그리드 |
| Artists | `#artists` | 작가 목록 |
| Private Sales | `#private-sales` | 비공개 거래 문의 폼 |
| Signal | `#signal` | 카드뉴스 에디토리얼 |
| Journal | `#journal` | 아티클 목록 |
| About | `#about` | 소개 + 연락처 |

## 실행 방법

```bash
# 브라우저에서 직접 열기
open index.html

# 또는 로컬 서버 실행
python3 -m http.server 8080
# → http://localhost:8080
```

## 디자인 시스템

- **배경**: `#FFFFFF`
- **주요 색상**: `#0d1b2a` (다크 네이비)
- **폰트**: Roboto 200/300/400/700 + Cormorant Garamond 300/400
- **스타일**: Ultra-minimal Editorial, 여백 중심

## 연동

- `Signal` 페이지 → `../art-cardnews/output/` 카드뉴스 파일 참조 가능
