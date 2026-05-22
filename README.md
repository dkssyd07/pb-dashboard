# ATLAS PB — 프라이빗 뱅킹 투자 플랫폼

프라이빗 뱅커(PB)를 위한 올인원 투자 대시보드입니다.

## 주요 기능

| 기능 | 설명 |
|------|------|
| 📊 **대시보드** | KOSPI/KOSDAQ/S&P500/NASDAQ 실시간 요약, 공포탐욕 지수 |
| 🇰🇷 **국내주식** | KRX 주요 종목, 섹터별 등락, 외국인 수급 |
| 🌐 **해외주식** | 미국/글로벌 주요 지수, ETF, 빅테크 종목 |
| 📉 **시장 지표** | VIX, 환율, 원자재, 경제 일정, 지표 해석 |
| 📄 **리포트 분석** | PDF 업로드 → Claude AI가 투자 인사이트 추출 |
| 💼 **포트폴리오** | AI 추천 종목, 포트폴리오 자동 생성 |

## 로컬 실행

```bash
# 방법 1: 브라우저에서 직접 열기
open index.html   # macOS
start index.html  # Windows

# 방법 2: 로컬 서버 (권장)
npx serve .
# 또는
python -m http.server 8080
# 브라우저에서 http://localhost:8080 접속
```

## AI 리포트 분석 활성화

1. [Anthropic Console](https://console.anthropic.com)에서 API 키 발급
2. **리포트 분석** 페이지 상단 입력창에 `sk-ant-...` 키 입력
3. PDF 리포트 업로드 후 **분석** 버튼 클릭
4. Q&A 채팅으로 리포트 내용 질의응답

> API 키 없이도 샘플 분석 결과를 확인하실 수 있습니다.

## 호스팅 방법

### Vercel (추천 — 무료)
```bash
npm install -g vercel
cd pb-dashboard
vercel
```

### Netlify
```bash
npm install -g netlify-cli
netlify deploy --dir=. --prod
```

### GitHub Pages
```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pb-dashboard.git
git push -u origin main
# GitHub Settings > Pages > Deploy from main branch
```

## 실시간 시세 연동 (선택 사항)

현재 버전은 샘플 데이터를 사용합니다. 실시간 데이터 연동 시:

| API | 용도 | 비고 |
|-----|------|------|
| [KIS Developers](https://apiportal.koreainvestment.com) | 국내 실시간 | 한국투자증권 |
| [Alpha Vantage](https://www.alphavantage.co) | 해외 종목 | 무료 플랜 있음 |
| [Yahoo Finance API](https://finance.yahoo.com) | 글로벌 지수 | 비공식 API |
| [Fear & Greed API](https://api.alternative.me/fng/) | 공포탐욕 지수 | 무료 |

## 기술 스택

- **Frontend**: HTML5 / CSS3 / Vanilla JavaScript
- **차트**: Chart.js 4.4
- **PDF 처리**: PDF.js 3.11
- **AI 분석**: Anthropic Claude API (claude-sonnet-4-20250514)
- **폰트**: DM Serif Display + DM Sans + JetBrains Mono

---
*ATLAS PB v1.0 — 투자 판단은 항상 고객의 상황과 PB의 전문 판단을 종합하여 이루어져야 합니다.*
