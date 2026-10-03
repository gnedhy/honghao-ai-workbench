import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Actual mounted consumers, synthetic responses; no backend or production proxy.
const entry = process.cwd().replaceAll('\\', '/') + '/loading-check.tsx';
const server = await createServer({ configFile: false, cacheDir: '.scratch/w3-loading-cache', plugins: [react(), {
  name: 'loading-check',
  configureServer(server) { server.middlewares.use(async (req, res, next) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) { res.statusCode = 503; res.end('Mock interception required'); return; }
    if (path !== '/loading-check') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml(path, '<html><body><div id="root"></div><script type="module" src="/loading-check.tsx"></script></body></html>'));
  }); },
  resolveId(id) { if (id === '/loading-check.tsx' || id === entry) return entry; },
  load(id) { if (id === entry) return `import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {ProcurementWorkbench} from '/src/workbenches/ProcurementWorkbench';
import {ResearchWorkbench} from '/src/workbenches/ResearchWorkbench';
import {ProcurementNews} from '/src/workbenches/ProcurementNews';
import {ProcurementDistribution} from '/src/workbenches/ProcurementDistribution';
import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';
import '/src/styles.css';
const kind=new URLSearchParams(location.search).get('kind');
const props={accessLevel:2,view:'preview',page:'dashboard',userId:'test',onPageChange:()=>{},onEnter:()=>{}};
const sales={...props,view:'full',page:kind==='calculator'?'estimator':'calculate',currentUser:{id:'loading-test',scope_levels:{sales:2}}};
createRoot(document.getElementById('root')).render(kind==='research'?h(ResearchWorkbench,props):kind==='news'?h(ProcurementNews,{cache:{current:null}}):kind==='distribution'?h(ProcurementDistribution,{revision:0,renderLedger:()=>null}):kind==='sales'||kind==='calculator'?h(SalesWorkbench,sales):h(ProcurementWorkbench,props));`; },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls.local[0];
  async function run(name, kind, respond, check) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(7000);
    const errors = [], unexpected = []; page.on('pageerror', error => errors.push(error.message));
    const salesPaths = ['products', 'batches', 'history', 'records'].map(path => 'GET /api/workbenches/sales/' + path);
    const expected = kind === 'sales' ? salesPaths : kind === 'calculator' ? [...salesPaths, 'GET /api/workbenches/sales/calculator/saved', 'POST /api/workbenches/sales/calculator/evaluate']
      : kind === 'research' ? ['products', 'history', 'formulas', 'products/recipe%3Atest'].map(path => 'GET /api/workbenches/research/' + path)
      : ['GET /api/workbenches/procurement/' + (kind === 'news' ? 'news' : 'overview')];
    await page.route('**/*', async route => {
      try {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(origin).origin) { unexpected.push(url.origin); return await route.abort(); }
        if (!url.pathname.startsWith('/api/')) return await route.continue();
        const request = route.request().method() + ' ' + url.pathname;
        if (!expected.includes(request)) { unexpected.push(request); return await route.abort(); }
        await respond(route, url.pathname);
      } catch (error) { errors.push(error.message); await route.abort().catch(() => {}); }
    });
    try {
      await page.goto(origin + 'loading-check?kind=' + kind); await check(page);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); console.log('PASS', name);
    } finally { await page.close(); }
  }
  for (const kind of ['procurement', 'research', 'news', 'distribution']) {
    const pending = gate();
    await run('loading -> failure: ' + kind, kind, async route => {
      await pending.promise; await route.fulfill({ status: 500, json: { detail: '合成读取失败' } });
    }, async page => {
      const spinner = page.locator('[role="status"] svg').first(); await spinner.waitFor();
      const before = await spinner.evaluate(e => getComputedStyle(e).transform); await page.waitForTimeout(120);
      assert.notEqual(await spinner.evaluate(e => getComputedStyle(e).transform), before);
      await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await spinner.evaluate(e => getComputedStyle(e).animationName), 'none');
      pending.release(); await spinner.waitFor({ state: 'detached' });
      await page.getByText(/暂时不可用|暂时无法读取|读取失败|合成读取失败/).first().waitFor();
    });
  }
  const trend = gate();
  await run('research trend: pending distinct from empty', 'research', async (route, path) => {
    if (path.endsWith('/products')) return route.fulfill({ json: { products: [{ id: 'recipe:test', name: '测试产品', status: 'ready', yield: '100', change: null, latest_cost: '1', inventory_cost: '1' }], pending: false } });
    if (path.endsWith('/history')) return route.fulfill({ json: { versions: [] } });
    if (path.endsWith('/formulas')) return route.fulfill({ json: { formulas: [], owners: [] } });
    await trend.promise; await route.fulfill({ json: { history: [] } });
  }, async page => {
    await page.getByText('正在读取研发成本走势', { exact: true }).waitFor(); assert.equal(await page.getByText('当前范围没有成本记录', { exact: true }).count(), 0);
    trend.release(); await page.getByText('当前范围没有成本记录', { exact: true }).waitFor(); assert.equal(await page.getByText('正在读取研发成本走势', { exact: true }).count(), 0);
  });
  const sales = [gate(), gate()]; let retry = false;
  const empty = path => ({ [path.endsWith('/products') ? 'products' : path.endsWith('/batches') ? 'batches' : path.endsWith('/history') ? 'trials' : 'records']: [] });
  await run('sales: pending -> failure -> retry -> empty', 'sales', async (route, path) => {
    await sales[retry ? 1 : 0].promise;
    await route.fulfill(retry ? { json: empty(path) } : { status: 500, json: { detail: '合成读取失败' } });
  }, async page => {
    await page.getByText('正在加载销售工作台', { exact: true }).waitFor(); assert.equal(await page.getByText('没有符合条件的产品。', { exact: true }).count(), 0);
    sales[0].release(); await page.getByText('销售工作台暂时不可用', { exact: true }).waitFor(); assert.equal(await page.getByText('没有符合条件的产品。', { exact: true }).count(), 0);
    retry = true; await page.getByRole('button', { name: '重新加载', exact: true }).click(); await page.getByText('正在加载销售工作台', { exact: true }).waitFor();
    sales[1].release(); await page.getByText('没有符合条件的产品。', { exact: true }).waitFor();
  });
  const history = [gate(), gate()], evaluations = []; let historyRetry = false;
  await run('calculator: history pending/failure/retry/empty; evaluation failure and out-of-order responses', 'calculator', async (route, path) => {
    if (path.endsWith('/calculator/saved')) {
      await history[historyRetry ? 1 : 0].promise;
      return route.fulfill(historyRetry ? { json: { saved: [] } } : { status: 500, json: { detail: '合成历史读取失败' } });
    }
    if (path.endsWith('/calculator/evaluate')) { evaluations.push(route); return; }
    await route.fulfill({ json: empty(path) });
  }, async page => {
    await page.getByText('历史测算', { exact: true }).click(); await page.getByText('正在读取历史测算', { exact: true }).waitFor(); assert.equal(await page.getByText('暂无历史测算', { exact: true }).count(), 0);
    history[0].release(); await page.getByRole('alert').filter({ hasText: '合成历史读取失败' }).waitFor(); assert.equal(await page.getByText('暂无历史测算', { exact: true }).count(), 0);
    historyRetry = true; await page.getByRole('button', { name: '重试', exact: true }).click(); await page.getByText('正在读取历史测算', { exact: true }).waitFor();
    history[1].release(); await page.getByText('暂无历史测算', { exact: true }).waitFor(); await page.getByText('历史测算', { exact: true }).click();
    const waitRequest = async count => { const limit = Date.now() + 7000; while (evaluations.length < count && Date.now() < limit) await page.waitForTimeout(20); assert.ok(evaluations.length >= count, 'evaluation request missing'); };
    await page.getByText('计算中…', { exact: true }).first().waitFor(); await waitRequest(1);
    await evaluations[0].fulfill({ status: 500, json: { detail: '合成测算失败' } }); await page.getByRole('alert').filter({ hasText: '测算暂时无法完成' }).waitFor(); assert.equal(await page.getByText('计算中…', { exact: true }).count(), 0);
    await page.getByRole('textbox', { name: '手工产品成本', exact: true }).fill('5'); await waitRequest(2);
    await page.getByRole('textbox', { name: '手工产品成本', exact: true }).fill('6'); await waitRequest(3);
    const reply = (route, price) => { const body = route.request().postDataJSON(); return route.fulfill({ json: { source: body.source, results: body.panels.map(panel => ({ id: panel.id, result: { price, target_cost: null, cost_gap: null, trail: [] }, error: null })), default_allocation_tiers: [] } }); };
    await reply(evaluations[2], '6.92'); await page.getByText('6.92 元/kg', { exact: true }).first().waitFor();
    await reply(evaluations[1], '99.99'); await page.waitForTimeout(150);
    assert.equal(await page.getByText('99.99 元/kg', { exact: true }).count(), 0); assert.equal(await page.getByRole('textbox', { name: '手工产品成本', exact: true }).inputValue(), '6'); assert.equal(await page.getByText('6.92 元/kg', { exact: true }).count(), 2);
  });
} finally { await browser?.close(); await server.close(); }
