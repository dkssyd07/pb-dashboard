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
    'authorization':  `Bearer ${token}`,
    'appkey':         process.env.KIS_APPKEY,
    'appsecret':      process.env.KIS_APPSECRET,
    'tr_id':          trId,
    'custtype':       'P',
    'content-type':   'application/json'
  };
}

// ── 전역 KIS 요청 큐 (100ms 간격) ──
let _kisQueue = Promise.resolve();
function kisReq(fn) {
  _kisQueue = _kisQueue.then(async () => {
    const result = await fn();
    await new Promise(r => setTimeout(r, 100));
    return result;
  });
  return _kisQueue;
}

// ── 응답 캐시 ──
const _cache = {};
const TTL_QUOTE = 90  * 1000;
const TTL_CHART = 10  * 60 * 1000;
const TTL_INV   = 60  * 1000;

function cGet(key, ttl) {
  const e = _cache[key];
  if (e && Date.now() - e.ts < ttl) return e.data;
  return null;
}
function cSet(key, data) {
  _cache[key] = { data, ts: Date.now() };
  return data;
}

// ── SSE 클라이언트 관리 ──
const sseClients = new Set();

function pushToClients(snapshot) {
  if (!sseClients.size) return;
  const msg = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); }
    catch(e) { sseClients.delete(res); }
  }
  console.log(`[SSE] ${sseClients.size}명에게 푸시 완료`);
}

function buildSnapshot() {
  const krKey = 'kr_' + KR_WARM.join(',');
  const usKey = 'us_' + US_WARM.map(s => s.sym).join(',');
  return {
    ts:       Date.now(),
    index:    cGet('index_kr', TTL_QUOTE * 2),
    krQuotes: cGet(krKey, TTL_QUOTE * 2) || [],
    usQuotes: cGet(usKey, TTL_QUOTE * 2) || [],
  };
}

// ── SSE 스트림 엔드포인트 ──
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 버퍼링 비활성화 (Render 필요)

  // 연결 즉시 캐시된 데이터 전송
  const snap = buildSnapshot();
  if (snap.index || snap.krQuotes.length) {
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
  } else {
    res.write(`: 데이터 준비 중...\n\n`);
  }

  sseClients.add(res);
  console.log(`[SSE] 연결됨 (총 ${sseClients.size}명)`);

  // 25초마다 heartbeat (Render 타임아웃 방지)
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch(e) { clearInterval(hb); sseClients.delete(res); }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
    console.log(`[SSE] 연결 해제 (총 ${sseClients.size}명)`);
  });
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now(), clients: sseClients.size }));

// ── KOSPI / KOSDAQ 지수 ──
app.get('/api/index/kr', async (req, res) => {
  const hit = cGet('index_kr', TTL_QUOTE);
  if (hit) return res.json(hit);
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
    res.json(cSet('index_kr', { kospi, kosdaq }));
  } catch (e) {
    console.error('[/api/index/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 국내 주식 현재가 배치 ──
app.post('/api/quotes/kr', async (req, res) => {
  const codes = req.body.codes || [];
  if (!codes.length) return res.json([]);
  const key = 'kr_' + [...codes].sort().join(',');
  const hit = cGet(key, TTL_QUOTE);
  if (hit) return res.json(hit);
  try {
    const token   = await getToken();
    const results = [];
    for (const code of codes) {
      const r = await kisReq(async () => {
        try {
          const res = await axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-price`, {
            headers: h(token, 'FHKST01010100'),
            params:  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }
          });
          return { code, q: res.data.output };
        } catch(e) {
          console.error(`[quote/${code}]`, e.response?.status);
          return { code, q: null };
        }
      });
      results.push(r);
    }
    res.json(cSet(key, results));
  } catch (e) {
    console.error('[/api/quotes/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 국내 주식 일봉 차트 ──
app.get('/api/chart/kr/:code', async (req, res) => {
  const range = req.query.range || '1mo';
  const key   = `chart_kr_${req.params.code}_${range}`;
  const hit   = cGet(key, TTL_CHART);
  if (hit) return res.json(hit);
  try {
    const token  = await getToken();
    const days   = ({ '1mo':30, '3mo':90, '6mo':180, '1y':365 })[range] || 30;
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
    res.json(cSet(key, (data.output2 || []).reverse()));
  } catch (e) {
    const body = e.response?.data;
    console.error('[/api/chart/kr]', e.response?.status, JSON.stringify(body));
    res.status(500).json({ error: e.message, detail: body });
  }
});

// ── 국내 주식 단일 현재가 ──
app.get('/api/quote/kr/:code', async (req, res) => {
  const key = `quote1_kr_${req.params.code}`;
  const hit = cGet(key, TTL_QUOTE);
  if (hit) return res.json(hit);
  try {
    const token = await getToken();
    const { data } = await axios.get(
      `${KIS}/uapi/domestic-stock/v1/quotations/inquire-price`,
      { headers: h(token, 'FHKST01010100'), params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: req.params.code } }
    );
    res.json(cSet(key, data.output || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 해외 주식 현재가 배치 ──
app.post('/api/quotes/us', async (req, res) => {
  const stocks = req.body.stocks || [];
  if (!stocks.length) return res.json([]);
  const key = 'us_' + [...stocks].map(s => s.sym).sort().join(',');
  const hit = cGet(key, TTL_QUOTE);
  if (hit) return res.json(hit);
  try {
    const token   = await getToken();
    const results = [];
    for (const { sym, excd } of stocks) {
      const r = await kisReq(async () => {
        try {
          const res = await axios.get(`${KIS}/uapi/overseas-price/v1/quotations/price`, {
            headers: h(token, 'HHDFS00000300'),
            params:  { AUTH: '', EXCD: excd, SYMB: sym }
          });
          return { sym, excd, q: res.data.output };
        } catch(e) {
          console.error(`[us-quote/${sym}]`, e.response?.status);
          return { sym, excd, q: null };
        }
      });
      results.push(r);
    }
    res.json(cSet(key, results));
  } catch (e) {
    console.error('[/api/quotes/us]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 해외 주식 일봉 차트 ──
app.get('/api/chart/us/:symbol', async (req, res) => {
  const range = req.query.range || '1mo';
  const excd  = req.query.excd  || 'NAS';
  const key   = `chart_us_${req.params.symbol}_${excd}_${range}`;
  const hit   = cGet(key, TTL_CHART);
  if (hit) return res.json(hit);
  try {
    const token = await getToken();
    const { data } = await axios.get(
      `${KIS}/uapi/overseas-price/v1/quotations/dailyprice`,
      { headers: h(token, 'HHDFS76240000'), params: { AUTH: '', EXCD: excd, SYMB: req.params.symbol, GUBN: '0', BYMD: '', MODP: '1' } }
    );
    res.json(cSet(key, (data.output2 || []).reverse()));
  } catch (e) {
    console.error('[/api/chart/us]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 투자자별 매매동향 ──
app.get('/api/investor/kr/:code', async (req, res) => {
  const key = `inv_${req.params.code}`;
  const hit = cGet(key, TTL_INV);
  if (hit) return res.json(hit);
  try {
    const token  = await getToken();
    const result = await kisReq(() =>
      axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-investor`, {
        headers: h(token, 'FHKST01010900'),
        params:  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: req.params.code }
      }).then(r => r.data.output || []).catch(e => {
        console.error(`[investor/${req.params.code}]`, e.response?.status);
        return [];
      })
    );
    res.json(cSet(key, result));
  } catch (e) {
    console.error('[/api/investor/kr]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 백그라운드 캐시 예열 + SSE 푸시 ──
const KR_WARM = ['005930','000660','035420','051910','006400','035720','028260','003550','207940','005380','105560','005490'];
const US_WARM = [
  {sym:'NVDA',excd:'NAS'},{sym:'AMD',excd:'NAS'},{sym:'AVGO',excd:'NAS'},
  {sym:'AAPL',excd:'NAS'},{sym:'MSFT',excd:'NAS'},{sym:'GOOGL',excd:'NAS'},
  {sym:'META',excd:'NAS'},{sym:'AMZN',excd:'NAS'},{sym:'TSLA',excd:'NAS'},
  {sym:'JNJ',excd:'NYS'},{sym:'PFE',excd:'NYS'},{sym:'MRNA',excd:'NAS'},
  {sym:'XOM',excd:'NYS'},{sym:'JPM',excd:'NYS'}
];

async function warmCache() {
  try {
    console.log('[WARM] 예열 시작...');
    const token = await getToken();

    // 지수
    const kospi = await kisReq(() =>
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
    cSet('index_kr', { kospi, kosdaq });

    // 국내 시세
    const krResults = [];
    for (const code of KR_WARM) {
      const r = await kisReq(async () => {
        try {
          const res = await axios.get(`${KIS}/uapi/domestic-stock/v1/quotations/inquire-price`, {
            headers: h(token, 'FHKST01010100'),
            params:  { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code }
          });
          return { code, q: res.data.output };
        } catch(e) { return { code, q: null }; }
      });
      krResults.push(r);
    }
    cSet('kr_' + KR_WARM.join(','), krResults);

    // 해외 시세
    const usResults = [];
    for (const { sym, excd } of US_WARM) {
      const r = await kisReq(async () => {
        try {
          const res = await axios.get(`${KIS}/uapi/overseas-price/v1/quotations/price`, {
            headers: h(token, 'HHDFS00000300'),
            params:  { AUTH: '', EXCD: excd, SYMB: sym }
          });
          return { sym, excd, q: res.data.output };
        } catch(e) { return { sym, excd, q: null }; }
      });
      usResults.push(r);
    }
    cSet('us_' + US_WARM.map(s => s.sym).join(','), usResults);

    const krOk = krResults.filter(r => r.q).length;
    const usOk = usResults.filter(r => r.q).length;
    console.log(`[WARM] 완료 — KR ${krOk}/${KR_WARM.length}, US ${usOk}/${US_WARM.length}`);

    // 연결된 모든 클라이언트에 즉시 푸시
    pushToClients(buildSnapshot());
  } catch (e) {
    console.error('[WARM] 오류:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EGY API server running on :${PORT}`);
  setTimeout(warmCache, 3000);        // 시작 3초 후 첫 예열
  setInterval(warmCache, 55 * 1000);  // 이후 55초마다 자동 갱신 + SSE 푸시
});
