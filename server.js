/**
 * Fish to Business — единый сервер
 *
 * Маршруты:
 *   /                          → public/monitor.html  (монитор цен, внутренний)
 *   /admin                     → public/admin.html    (управление прайс-листом)
 *   /price-monitor             → public/price-monitor.html  (новый монитор, браузерный)
 *
 *   — Монитор цен (МойСклад Bearer-токен) —
 *   GET  /api/data             → все товары, цены, остатки, продажи
 *   PUT  /api/price            → обновить цену товара в МС
 *   PUT  /api/archive          → архивировать товар в МС
 *   GET  /api/settings         → сохранённые настройки монитора
 *   POST /api/settings         → сохранить настройки монитора
 *
 *   — Прайс-лист (Fish to Business) —
 *   GET  /api/pricelist        → получить данные прайса
 *   POST /api/pricelist        → сохранить данные прайса
 *   GET  /api/moysklad/product?code=XXX  → найти товар в МС по коду
 *   POST /api/moysklad/sync    → обновить цены товаров в прайсе из МС
 *   POST /api/moysklad/test    → проверить подключение (login/password Basic Auth)
 *
 *   — Debug —
 *   GET  /api/debug/stores     → список складов
 *   GET  /api/debug/stock      → первые строки отчёта остатков
 *   GET  /api/debug/product?code=XXX
 *
 * Переменные окружения:
 *   PORT                  (по умолчанию 3000)
 *   DATA_DIR              (по умолчанию /app/data)
 *   MOYSKLAD_TOKEN        Bearer-токен для монитора цен
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const zlib  = require('zlib');

const PORT = process.env.PORT || 3000;

const DATA_DIR = (() => {
  const d = process.env.DATA_DIR || '/app/data';
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; }
  catch { return __dirname; }
})();

const MONITOR_FILE   = path.join(DATA_DIR, 'monitor-data.json');
const PRICELIST_FILE = path.join(DATA_DIR, 'pricelist.json');
const PUBLIC_DIR     = path.join(__dirname, 'public');

let MS_TOKEN = process.env.MOYSKLAD_TOKEN || '';

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendErr(res, msg, status = 400) { sendJSON(res, { error: msg }, status); }

function readBody(req) {
  return new Promise((ok, fail) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 50e6) req.destroy(); });
    req.on('end',  () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
    req.on('error', fail);
  });
}

function serveFile(res, filePath) {
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(filePath));
  } catch {
    res.writeHead(404); res.end('File not found');
  }
}

// ─── Хранилище монитора цен ───────────────────────────────────────────────────

function loadMonitorData() {
  try {
    if (fs.existsSync(MONITOR_FILE))
      return JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
  } catch {}
  return { rowOrder: [], competitorPrices: {}, collapsedGroups: [] };
}

function saveMonitorData(d) {
  fs.writeFileSync(MONITOR_FILE, JSON.stringify(d, null, 2), 'utf8');
}

// ─── Хранилище прайс-листа ────────────────────────────────────────────────────

function loadPricelist() {
  try {
    if (fs.existsSync(PRICELIST_FILE))
      return JSON.parse(fs.readFileSync(PRICELIST_FILE, 'utf8'));
  } catch {}
  return { company: {}, links: [], categories: [] };
}

function savePricelist(d) {
  fs.writeFileSync(PRICELIST_FILE, JSON.stringify(d, null, 2), 'utf8');
}

// ─── МойСклад API (Bearer-токен) ──────────────────────────────────────────────

function msRequest(endpoint, method = 'GET', body = null, token = null) {
  return new Promise((ok, fail) => {
    const t = token || MS_TOKEN;
    if (!t) { fail(new Error('MOYSKLAD_TOKEN не задан')); return; }
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.moysklad.ru',
      path: '/api/remap/1.2' + endpoint,
      method,
      headers: {
        'Authorization':   'Bearer ' + t,
        'Accept-Encoding': 'gzip',
        'Content-Type':    'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const raw = res.headers['content-encoding'] === 'gzip'
            ? zlib.gunzipSync(buf).toString('utf8')
            : buf.toString('utf8');
          if (!raw) { ok({}); return; }
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) fail(new Error(data.errors?.[0]?.error || 'HTTP ' + res.statusCode));
          else ok(data);
        } catch (e) { fail(e); }
      });
    });
    req.on('error', fail);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** МойСклад Basic Auth (для проверки логина/пароля из admin-панели) */
function msRequestBasic(endpoint, login, password) {
  return new Promise((ok, fail) => {
    const creds = Buffer.from(`${login}:${password}`).toString('base64');
    const opts = {
      hostname: 'api.moysklad.ru',
      path:     '/api/remap/1.2' + endpoint,
      method:   'GET',
      headers:  {
        'Authorization':   'Basic ' + creds,
        'Accept-Encoding': 'gzip',
        'Content-Type':    'application/json'
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const raw = res.headers['content-encoding'] === 'gzip'
            ? zlib.gunzipSync(buf).toString('utf8')
            : buf.toString('utf8');
          const data = JSON.parse(raw || '{}');
          if (res.statusCode >= 400) fail(new Error(data.errors?.[0]?.error || 'HTTP ' + res.statusCode));
          else ok(data);
        } catch (e) { fail(e); }
      });
    });
    req.on('error', fail);
    req.end();
  });
}

function msGet(endpoint) { return msRequest(endpoint, 'GET'); }

async function msGetAll(endpoint) {
  let offset = 0;
  const limit = 100;
  let all = [];
  while (true) {
    const sep  = endpoint.includes('?') ? '&' : '?';
    const data = await msGet(`${endpoint}${sep}limit=${limit}&offset=${offset}`);
    const rows = data.rows || [];
    all = all.concat(rows);
    if (all.length >= (data.meta?.size || 0) || rows.length === 0) break;
    offset += limit;
  }
  return all;
}

// ─── Построение данных монитора ───────────────────────────────────────────────

function msVal(v) { return (v || v === 0) ? v / 100 : null; }

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function trimmedAvg(values) {
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  const med = median(values);
  if (med === 0) return null;
  const filtered = values.filter(v => Math.abs(v - med) / med <= 0.80);
  if (!filtered.length) return med;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

function buildProduct(p, stockMap, costMap, salesThis, salesLast, salesOlder, priceTypes) {
  const stock  = stockMap[p.id] ?? 0;
  const prices = priceTypes.map(pt => {
    const sp = (p.salePrices || []).find(x => x.priceType?.id === pt.id);
    return sp ? msVal(sp.value) : 0;
  });
  while (prices.length < 3) prices.push(0);

  const costFromSales = salesThis[p.id]?.avgCost || salesLast[p.id]?.avgCost || salesOlder[p.id]?.avgCost || 0;
  const rawCost       = costFromSales || costMap[p.id] || msVal(p.buyPrice?.value) || 0;
  const minPrice      = prices.filter(x => x > 0).reduce((a, b) => Math.min(a, b), Infinity);
  const costPrice     = (rawCost > 0 && minPrice < Infinity && rawCost < minPrice * 0.20) ? 0 : rawCost;

  const markup0 = (prices[0] > 0 && costPrice > 0)
    ? Math.round((prices[0] - costPrice) / costPrice * 100) : null;

  const saleThis = salesThis[p.id];
  const saleLast = salesLast[p.id];

  const realPrice      = saleThis ? saleThis.avgPrice : null;
  const realMarkup     = (realPrice && costPrice > 0)
    ? Math.round((realPrice - costPrice) / costPrice * 100) : null;
  const prevRealMarkup = (saleLast && costPrice > 0)
    ? Math.round((saleLast.avgPrice - costPrice) / costPrice * 100) : null;
  const markupDelta    = (realMarkup !== null && prevRealMarkup !== null)
    ? realMarkup - prevRealMarkup : null;

  let deltaReason = null;
  if (markupDelta !== null && Math.abs(markupDelta) >= 1) {
    const priceDiff = realPrice - (saleLast?.avgPrice || realPrice);
    deltaReason     = Math.abs(priceDiff) > 0.01 ? (priceDiff < 0 ? 'цена ↓' : 'цена ↑') : 'себест ↑';
  }

  return {
    id: p.id, name: p.name, code: p.code || p.article || '',
    category: (() => {
      const pth = p.pathName || '';
      if (pth.toUpperCase().startsWith('ГОТОВАЯ ПРОДУКЦИЯ'))    return 'ГОТОВАЯ ПРОДУКЦИЯ';
      if (pth.toUpperCase().startsWith('ПРИВЛЕЧЕННЫЕ ТОВАРЫ')) {
        const parts = pth.split('/');
        return parts.slice(0, 2).join('/');
      }
      return pth || 'Без категории';
    })(),
    stock, costPrice, prices, markup0,
    realPrice, realMarkup, markupDelta, deltaReason,
    archived: p.archived || false,
    salePriceTypeIds: (p.salePrices || []).map(sp => sp.priceType?.id),
  };
}

async function getSalesData(dateFrom, dateTo) {
  const result      = {};
  const costSamples = {};

  try {
    let offset = 0;
    while (true) {
      const report = await msGet(
        `/report/profit/byproduct?momentFrom=${dateFrom}%2000%3A00%3A00&momentTo=${dateTo}%2023%3A59%3A59&limit=1000&offset=${offset}`
      );
      const rows = report.rows || [];
      rows.forEach(row => {
        const href = row.assortment?.meta?.href || '';
        const id   = href.split('/').pop();
        if (!id) return;
        const sellQty = row.sellQuantity || 0;
        const sellSum = msVal(row.sellSum) || 0;
        const costSum = msVal(row.costSum) || 0;
        if (sellQty > 0) {
          result[id] = { avgPrice: sellSum / sellQty, qty: sellQty };
          const costPerUnit = costSum / sellQty;
          if (costPerUnit > 0) {
            if (!costSamples[id]) costSamples[id] = [];
            costSamples[id].push(costPerUnit);
          }
        }
      });
      if (rows.length < 1000) break;
      offset += 1000;
    }
    console.log('Profit report OK:', Object.keys(result).length, 'products');
  } catch (e) { console.warn('Profit report failed:', e.message); }

  try {
    const demands = await msGetAll(
      `/entity/demand?filter=moment>=${dateFrom}%2000%3A00%3A00;moment<=${dateTo}%2023%3A59%3A59&expand=positions&order=moment,desc`
    );
    const costByProduct = {};
    for (const demand of demands) {
      const moment    = demand.moment || '';
      const positions = demand.positions?.rows || demand.positions || [];
      for (const pos of positions) {
        const href  = pos.assortment?.meta?.href || '';
        const id    = href.split('/').pop();
        if (!id) continue;
        const cost  = msVal(pos.cost)  || 0;
        const price = msVal(pos.price) || 0;
        const qty   = pos.quantity     || 0;
        if (qty <= 0) continue;
        if (!result[id] && price > 0) result[id] = { avgPrice: price, qty };
        if (cost > 0) {
          if (!costByProduct[id]) costByProduct[id] = [];
          costByProduct[id].push({ cost, moment });
        }
      }
    }
    Object.keys(costByProduct).forEach(id => {
      const sorted = costByProduct[id].sort((a, b) => b.moment.localeCompare(a.moment));
      const recent = sorted.slice(0, 10).map(x => x.cost);
      if (!costSamples[id]) costSamples[id] = [];
      costSamples[id].push(...recent);
    });
  } catch (e) { console.warn('Demands expand failed:', e.message); }

  Object.keys(costSamples).forEach(id => {
    const avg = trimmedAvg(costSamples[id]);
    if (avg !== null && avg > 0) {
      if (!result[id]) result[id] = { avgPrice: 0, qty: 0 };
      result[id].avgCost = avg;
    }
  });

  return result;
}

async function loadMSData() {
  // 1. Price types
  const ptSample    = await msGet('/entity/product?limit=1');
  const sampleProd  = ptSample.rows?.[0];
  const priceTypes  = (sampleProd?.salePrices || []).slice(0, 2).map(sp => ({
    id:   sp.priceType?.id || sp.priceType?.meta?.href?.split('/').pop() || '',
    name: sp.priceType?.name || 'Цена'
  }));

  // 2. Products — только нужные каталоги
  const ALLOWED = ['ГОТОВАЯ ПРОДУКЦИЯ', 'ПРИВЛЕЧЕННЫЕ ТОВАРЫ'];
  const allProducts = await msGetAll('/entity/product?archived=false');
  const products    = allProducts.filter(p =>
    ALLOWED.some(cat => (p.pathName || '').toUpperCase().startsWith(cat))
  );
  console.log(`Filtered: ${products.length} of ${allProducts.length} products`);

  // 3. Stock — только Основной склад
  let stockMap = {}, costMap = {}, mainStoreId = '';
  try {
    const stores    = await msGet('/entity/store');
    const mainStore = (stores.rows || []).find(s => s.name === 'Основной склад');
    if (mainStore) mainStoreId = mainStore.id;
    console.log('Main store:', mainStoreId || 'not found, using all');
  } catch (e) { console.warn('Store lookup failed:', e.message); }

  try {
    let offset = 0;
    while (true) {
      const storeFilter  = mainStoreId
        ? `&filter=store=https://api.moysklad.ru/api/remap/1.2/entity/store/${mainStoreId}` : '';
      const stockResp = await msGet(`/report/stock/all?stockMode=all&limit=1000&offset=${offset}${storeFilter}`);
      const rows = stockResp.rows || [];
      rows.forEach(r => {
        const id = r.meta?.href?.split('?')[0]?.split('/').pop() || r.id;
        if (id) {
          stockMap[id] = (stockMap[id] || 0) + (r.stock || 0);
          if (r.price   > 0) costMap[id] = r.price   / 100;
          else if (r.avgCost > 0) costMap[id] = r.avgCost / 100;
        }
      });
      if (rows.length < 1000) break;
      offset += 1000;
    }
    console.log('Stock loaded:', Object.keys(stockMap).length);
  } catch (e) { console.warn('Stock report failed:', e.message); }

  // 4. Sales
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const thisMonthStart  = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const today           = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const lastMonth       = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart  = `${lastMonth.getFullYear()}-${pad(lastMonth.getMonth() + 1)}-01`;
  const lastMonthEnd    = new Date(now.getFullYear(), now.getMonth(), 0);
  const lastMonthEndStr = `${lastMonthEnd.getFullYear()}-${pad(lastMonthEnd.getMonth() + 1)}-${pad(lastMonthEnd.getDate())}`;
  const threeMonthsAgo  = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const threeMonthsStart= `${threeMonthsAgo.getFullYear()}-${pad(threeMonthsAgo.getMonth() + 1)}-01`;

  const [salesThis, salesLast, salesOlder] = await Promise.all([
    getSalesData(thisMonthStart, today).catch(() => ({})),
    getSalesData(lastMonthStart, lastMonthEndStr).catch(() => ({})),
    getSalesData(threeMonthsStart, lastMonthStart).catch(() => ({}))
  ]);

  // 5. Build
  Object.keys(salesThis).forEach(id => {
    if (salesThis[id].avgCost) costMap[id] = salesThis[id].avgCost;
  });

  return {
    products:   products.map(p => buildProduct(p, stockMap, costMap, salesThis, salesLast, salesOlder, priceTypes)),
    priceTypes: priceTypes.map(pt => ({ id: pt.id, name: pt.name })),
    loadedAt:   new Date().toISOString()
  };
}

// ─── Маршрутизатор ────────────────────────────────────────────────────────────

async function router(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname, query } = url.parse(req.url, true);

  // ── Страницы ──────────────────────────────────────────────────────────────

  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(res, path.join(PUBLIC_DIR, 'monitor.html'));
  }
  if (pathname === '/admin' || pathname === '/admin.html') {
    return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  }
  if (pathname === '/price-monitor' || pathname === '/price-monitor.html') {
    return serveFile(res, path.join(PUBLIC_DIR, 'price-monitor.html'));
  }

  // ── Монитор цен — API ─────────────────────────────────────────────────────

  if (pathname === '/api/data' && req.method === 'GET') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан', 401);
    try {
      return sendJSON(res, await loadMSData());
    } catch (e) {
      console.error('loadMSData error:', e);
      return sendErr(res, e.message, 500);
    }
  }

  if (pathname === '/api/price' && req.method === 'PUT') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан', 401);
    const body = await readBody(req);
    const { productId, priceTypeId, value } = body;
    if (!productId || value === undefined) return sendErr(res, 'Нужны productId и value');
    try {
      const prod       = await msGet(`/entity/product/${productId}`);
      const salePrices = prod.salePrices ? JSON.parse(JSON.stringify(prod.salePrices)) : [];
      const idx        = salePrices.findIndex(sp => sp.priceType?.id === priceTypeId);
      if (idx >= 0) salePrices[idx].value = Math.round(value * 100);
      else          salePrices.push({ value: Math.round(value * 100), priceType: { id: priceTypeId } });
      await msRequest(`/entity/product/${productId}`, 'PUT', { salePrices });
      return sendJSON(res, { ok: true });
    } catch (e) { return sendErr(res, e.message, 500); }
  }

  if (pathname === '/api/archive' && req.method === 'PUT') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан', 401);
    const body = await readBody(req);
    if (!body.productId) return sendErr(res, 'Нужен productId');
    try {
      await msRequest(`/entity/product/${body.productId}`, 'PUT', { archived: true });
      return sendJSON(res, { ok: true });
    } catch (e) { return sendErr(res, e.message, 500); }
  }

  if (pathname === '/api/settings') {
    if (req.method === 'GET')  return sendJSON(res, loadMonitorData());
    if (req.method === 'POST') {
      const body = await readBody(req);
      saveMonitorData(body);
      return sendJSON(res, { ok: true });
    }
  }

  // ── Прайс-лист — API ──────────────────────────────────────────────────────

  if (pathname === '/api/pricelist') {
    if (req.method === 'GET')  return sendJSON(res, loadPricelist());
    if (req.method === 'POST') {
      const body = await readBody(req);
      savePricelist(body);
      return sendJSON(res, { ok: true });
    }
  }

  // GET /api/moysklad/product?code=XXX — поиск товара по коду (для admin)
  if (pathname === '/api/moysklad/product' && req.method === 'GET') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан', 401);
    const code = query.code || '';
    if (!code) return sendErr(res, 'Нужен code');
    try {
      const r = await msGet(`/entity/product?search=${encodeURIComponent(code)}&limit=5`);
      const p = r.rows?.find(x => x.code === code || x.article === code) || r.rows?.[0];
      if (!p) return sendErr(res, 'Товар не найден', 404);
      const sp0   = p.salePrices?.[0];
      const price = sp0 ? msVal(sp0.value) : null;
      const unit  = p.uom?.name || 'кг';
      return sendJSON(res, { id: p.id, name: p.name, code: p.code || p.article || '', price, unit });
    } catch (e) { return sendErr(res, e.message, 500); }
  }

  // POST /api/moysklad/sync — обновить цены в прайсе из МС
  if (pathname === '/api/moysklad/sync' && req.method === 'POST') {
    if (!MS_TOKEN) return sendErr(res, 'MOYSKLAD_TOKEN не задан', 401);
    try {
      const pl      = loadPricelist();
      const codes   = [];
      pl.categories?.forEach(cat => cat.products?.forEach(p => { if (p.code) codes.push(p.code); }));
      if (!codes.length) return sendJSON(res, { updated: 0, products: [] });

      // Грузим все нужные товары пачками
      const found   = [];
      const chunk   = 50;
      for (let i = 0; i < codes.length; i += chunk) {
        const batch  = codes.slice(i, i + chunk);
        const filter = batch.map(c => `code=${encodeURIComponent(c)}`).join(';');
        try {
          const r = await msGet(`/entity/product?filter=${filter}&limit=100`);
          if (r.rows) found.push(...r.rows);
        } catch {}
      }

      const map     = {};
      found.forEach(p => {
        const sp    = p.salePrices?.[0];
        map[p.code] = { id: p.id, name: p.name, price: sp ? msVal(sp.value) : null, unit: p.uom?.name || 'кг' };
      });

      let updated = 0;
      pl.categories?.forEach(cat => cat.products?.forEach(p => {
        if (p.code && map[p.code]) {
          const u = map[p.code];
          if (u.price !== null) { p.price = u.price; updated++; }
          if (u.name)  p.name = u.name;
          if (u.unit)  p.unit = u.unit;
        }
      }));

      savePricelist(pl);
      return sendJSON(res, { updated, products: Object.values(map) });
    } catch (e) { return sendErr(res, e.message, 500); }
  }

  // POST /api/moysklad/test — проверить логин/пароль (Basic Auth)
  if (pathname === '/api/moysklad/test' && req.method === 'POST') {
    const body = await readBody(req);
    const { login, password } = body;
    if (!login || !password) return sendErr(res, 'Нужны login и password');
    try {
      const r = await msRequestBasic('/entity/employee?limit=1', login, password);
      const account = r.rows?.[0]?.accountId || login;
      return sendJSON(res, { ok: true, account });
    } catch (e) { return sendErr(res, e.message || 'Неверный логин или пароль', 401); }
  }

  // ── Debug ─────────────────────────────────────────────────────────────────

  if (pathname === '/api/debug/stores' && req.method === 'GET') {
    try {
      const r = await msGet('/entity/store');
      return sendJSON(res, r.rows.map(s => ({ id: s.id, name: s.name })));
    } catch (e) { return sendErr(res, e.message); }
  }

  if (pathname === '/api/debug/stock' && req.method === 'GET') {
    try {
      const r = await msGet('/report/stock/all?stockMode=all&limit=3');
      return sendJSON(res, { rows: r.rows, total: r.meta?.size });
    } catch (e) { return sendErr(res, e.message); }
  }

  if (pathname === '/api/debug/product' && req.method === 'GET') {
    try {
      const code = query.code || '';
      const r    = await msGet(`/entity/product?search=${encodeURIComponent(code)}&limit=1`);
      const p    = r.rows?.[0];
      if (!p) return sendErr(res, 'не найден');
      const sr   = await msGet('/report/stock/all?stockMode=all&limit=5');
      return sendJSON(res, { product: { id: p.id, name: p.name, code: p.code }, sampleStockRows: sr.rows, total: sr.meta?.size });
    } catch (e) { return sendErr(res, e.message); }
  }

  res.writeHead(404); res.end('Not found');
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

const saved = loadMonitorData();
if (!MS_TOKEN && saved._msToken) MS_TOKEN = saved._msToken;

http.createServer(async (req, res) => {
  try { await router(req, res); }
  catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); res.end('Error'); }
  }
}).listen(PORT, () => {
  console.log(`🐟 Fish to Business  →  http://localhost:${PORT}`);
  console.log(`   /              Монитор цен`);
  console.log(`   /admin         Управление прайс-листом`);
  console.log(`   /price-monitor Новый монитор (браузерный)`);
  console.log(MS_TOKEN ? '✅ Токен МойСклад загружен' : '⚠️  MOYSKLAD_TOKEN не задан (нужен для монитора и прайса)');
});
