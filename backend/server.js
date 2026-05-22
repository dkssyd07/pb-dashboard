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

// Health check (Render가 이 엔드포인트로 서버 상태 확인)
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── KOSPI / KOSDAQ 지수 ──
app.get('/api/index/kr', async (req, res) => {
  try {
    const token = await getToken();
    const fetchIdx = (iscd) =>
      axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-index-price`, {
        headers: h(token, 'FHPUP02100000'),
        params:  { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: iscd }
      }).then(r => r.data.output).catch(() => null);

    const [kospi, kosdaq] = await Promise.all([fetchIdx('0001'), fetchIdx('1001')]);
    res.json({ kospi, kosdaq });
  } catch (e) {
    console.error('[/api/index/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 국내 주식 현재가 배치 조회 ──
// POST /api/quotes/kr  body: { codes: ["005930","000660",...] }
app.post('/api/quotes/kr', async (req, res) => {
  const codes = req.body.codes || [];
  if (!codes.length) return res.json([]);
  try {
    const token = await getToken();
    const results = await Promise.all(codes.map(code =>
      axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-price`, {
        headers: h(token, 'FHKST01010100'),
        params:  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }
      }).then(r => ({ code, q: r.data.output }))
        .catch(e => { console.error(`[quote/${code}]`, e.message); return { code, q: null }; })
    ));
    res.json(results);
  } catch (e) {
    console.error('[/api/quotes/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 국내 주식 일봉 차트 ──
// GET /api/chart/kr/:code?range=6mo
app.get('/api/chart/kr/:code', async (req, res) => {
  try {
    const token = await getToken();
    const days  = ({ '1mo':30, '3mo':90, '6mo':180, '1y':365 })[req.query.range || '6mo'] || 180;
    const toDate = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const frDate = new Date(Date.now() - days * 86400000).toISOString().slice(0,10).replace(/-/g,'');

    const { data } = await axios.get(
      `${KIS}/uapi/domestic-stock/v1/quotations/inquire-daily-chartprice`,
      {
        headers: h(token, 'FHKST03010100'),
        params:  {
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD:          req.params.code,
          FID_INPUT_DATE_1:        frDate,
          FID_INPUT_DATE_2:        toDate,
          FID_PERIOD_DIV_CODE:     'D',
          FID_ORG_ADJ_PRC:         '0'
        }
      }
    );
    // output2: 일봉 배열 (최신순), 오름차순으로 뒤집어서 반환
    const rows = (data.output2 || []).reverse();
    res.json(rows);
  } catch (e) {
    console.error('[/api/chart/kr]', e.message);
    res.status(500).json({ error: e.message });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EGY API server running on :${PORT}`));
