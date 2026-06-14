const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const app     = express();

app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST']
}));

const KIS = 'https://openapi.koreainvestment.com:9443';
let _token = null, _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  const { data } = await axios.post(`${KIS}/oauth2/tokenP`, {
    grant_type: 'client_credentials',
    appkey:    process.env.KIS_APPKEY,
    appsecret: process.env.KIS_APPSECRET
  });
  _token    = data.access_token;
  _tokenExp = Date.now() + (data.expires_in - 300) * 1000;
  console.log('[KIS] 토큰 갱신 완료');
  return _token;
}

function h(token, trId) {
  return {
    'authorization': `Bearer ${token}`,
    'appkey':   process.env.KIS_APPKEY,
    'appsecret': process.env.KIS_APPSECRET,
    'tr_id':    trId,
    'custtype': 'P',
    'content-type': 'application/json'
  };
}

// ── 전역 KIS 요청 큐 (초당 제한 대응: 요청 간 200ms 간격) ──
let _kisQueue = Promise.resolve();
function kisReq(fn) {
  _kisQueue = _kisQueue.then(async () => {
    const result = await fn();
    await new Promise(r => setTimeout(r, 200));
    return result;
  });
  return _kisQueue;
}

// Health check (Render가 이 엔드포인트로 서버 상태 확인)
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── KOSPI / KOSDAQ 지수 ──
app.get('/api/index/kr', async (req, res) => {
  try {
    const token  = await getToken();
    const kospi  = await kisReq(() =>
      axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-index-price`, {
        headers: h(token, 'FHPUP02100000'),
        params:  { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001' }
      }).then(r => r.data.output).catch(() => null)
    );
    const kosdaq = await kisReq(() =>
      axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-index-price`, {
        headers: h(token, 'FHPUP02100000'),
        params:  { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '1001' }
      }).then(r => r.data.output).catch(() => null)
    );
    res.json({ kospi, kosdaq });
  } catch (e) {
    console.error('[/api/index/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 국내 주식 현재가 배치 조회 ──
app.post('/api/quotes/kr', async (req, res) => {
  const codes = req.body.codes || [];
  if (!codes.length) return res.json([]);
  try {
    const token = await getToken();
    const results = [];
    for (const code of codes) {
      const result = await kisReq(async () => {
        try {
          const r = await axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-price`, {
            headers: h(token, 'FHKST01010100'),
            params:  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }
          });
          return { code, q: r.data.output };
        } catch(e) {
          console.error(`[quote/${code}]`, e.response?.status, JSON.stringify(e.response?.data));
          return { code, q: null };
        }
      });
      results.push(result);
    }
    res.json(results);
  } catch (e) {
    console.error('[/api/quotes/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 국내 주식 일봉 차트 ──
app.get('/api/chart/kr/:code', async (req, res) => {
  try {
    const token  = await getToken();
    const days   = ({ '1mo':30, '3mo':90, '6mo':180, '1y':365 })[req.query.range || '1mo'] || 30;
    const toDate = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const frDate = new Date(Date.now() - days * 86400000).toISOString().slice(0,10).replace(/-/g,'');

    const { data } = await axios.get(
      `${KIS}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`,
      {
        headers: h(token, 'FHKST03010100'),
        params: {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD:          req.params.code,
          FID_INPUT_DATE_1:        frDate,
          FID_INPUT_DATE_2:        toDate,
          FID_PERIOD_DIV_CODE:     'D',
          FID_ORG_ADJ_PRC:         '0'
        }
      }
    );
    const rows = (data.output2 || []).reverse();
    res.json(rows);
  } catch (e) {
    const body = e.response?.data;
    console.error('[/api/chart/kr]', e.response?.status, JSON.stringify(body));
    res.status(500).json({ error: e.message, detail: body });
  }
});

// ── 국내 주식 단일 현재가 ──
app.get('/api/quote/kr/:code', async (req, res) => {
  try {
    const token = await getToken();
    const { data } = await axios.get(
      `${KIS}/uapi/domestic-stock/v1/quotations/inquire-price`,
      {
        headers: h(token, 'FHKST01010100'),
        params:  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: req.params.code }
      }
    );
    res.json(data.output || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 해외 주식 현재가 배치 ──
app.post('/api/quotes/us', async (req, res) => {
  const stocks = req.body.stocks || [];
  if (!stocks.length) return res.json([]);
  try {
    const token = await getToken();
    const results = [];
    for (const { sym, excd } of stocks) {
      const result = await kisReq(async () => {
        try {
          const r = await axios.get(`${KIS}/uapi/overseas-price/v1/quotations/price`, {
            headers: h(token, 'HHDFS00000300'),
            params:  { AUTH: '', EXCD: excd, SYMB: sym }
          });
          return { sym, excd, q: r.data.output };
        } catch(e) {
          console.error(`[us-quote/${sym}]`, e.response?.status, JSON.stringify(e.response?.data));
          return { sym, excd, q: null };
        }
      });
      results.push(result);
    }
    res.json(results);
  } catch (e) {
    console.error('[/api/quotes/us]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 해외 주식 일봉 차트 ──
// GET /api/chart/us/:symbol?excd=NAS&range=1mo
app.get('/api/chart/us/:symbol', async (req, res) => {
  try {
    const token = await getToken();
    const excd  = req.query.excd || 'NAS';
    const { data } = await axios.get(
      `${KIS}/uapi/overseas-price/v1/quotations/dailyprice`,
      {
        headers: h(token, 'HHDFS76240000'),
        params: { AUTH: '', EXCD: excd, SYMB: req.params.symbol, GUBN: '0', BYMD: '', MODP: '1' }
      }
    );
    // output2: 최신순 → 오름차순 반환
    res.json((data.output2 || []).reverse());
  } catch (e) {
    console.error('[/api/chart/us]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EGY API server running on :${PORT}`));
