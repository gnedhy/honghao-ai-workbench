import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// W1 fixed synthetic samples. This exercises real components; requests are mocked, not PostgreSQL.
const { values } = parseArgs({ options: { scenario: { type: 'string', default: 'smoke' } } });
assert.ok(['smoke', 'exits', 'interruptions', 'all'].includes(values.scenario));
const product = { id: 'research:recipe:W1', code: 'W1-Q1', name: '合成测试产品', source: 'research', department: '测试研发', status: 'ready', latest_cost: '4', inventory_cost: '12', special_allocation: false, source_version: 'w1-fixed-1' };
const user = { id: 'w1-manager', username: 'w1-manager', display_name: '合成测试经理', department: null, is_system_admin: false, scope_levels: { sales: 4 } };
const source = `import {createElement as h,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';
import {confirmWorkbenchLeave} from '/src/components/interactionNavigation';
import '/src/styles.css';
window.w1Leave=confirmWorkbenchLeave;
function Host(){const [page,setPage]=useState(new URLSearchParams(location.search).get('page')||'calculate');
return h(SalesWorkbench,{accessLevel:4,currentUser:${JSON.stringify(user)},page,onPageChange:setPage,view:'full',onEnter:()=>{}});}
createRoot(document.getElementById('root')).render(h(Host));`;
const entry = process.cwd().replaceAll('\\', '/') + '/w1-baseline.tsx';
const server = await createServer({ configFile: false, cacheDir: '.scratch/w1-20261002/vite-cache', plugins: [react(), {
  name: 'w1-sales-baseline',
  configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      const path = req.url.split('?')[0];
      // Fail closed even if browser interception is accidentally removed; no production proxy.
      if (path.startsWith('/api/')) { res.statusCode = 503; res.end('Mock interception required'); return; }
      if (path !== '/w1-baseline') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await instance.transformIndexHtml(path, '<html><body><div id="root"></div><script type="module" src="/w1-baseline.tsx"></script></body></html>'));
    });
  },
  resolveId(id) { if (id === '/w1-baseline.tsx' || id === entry) return entry; },
  load(id) { if (id === entry) return source; },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls.local[0];
  async function run(name, check, fault = '', pageName = 'calculate') {
    const started = performance.now();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(5000);
    const batches = [], writes = [], errors = [], unexpected = [];
    let injected = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== new URL(origin).origin) { unexpected.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/workbenches/sales', ''), method = request.method();
      const reply = json => route.fulfill({ json });
      if (method === 'GET') {
        if (path === '/products') return reply({ products: [product] });
        if (path === '/batches') return reply({ batches });
        if (path === '/history') return reply({ trials: [] });
        if (path === '/records') return reply({ records: [] });
        if (path === '/calculator/saved') return reply({ saved: [] });
        const batch = batches.find(row => path === '/batches/' + row.id);
        if (batch) return reply({ batch });
      }
      const body = request.postDataJSON();
      writes.push({ method, path, revision: body?.revision ?? null });
      if (path === '/calculator/evaluate' && method === 'POST') return reply({ source: body.source,
        results: body.panels.map(panel => ({ id: panel.id, result: { price: '6.92', target_cost: null, cost_gap: null, trail: [] }, error: null })), default_allocation_tiers: [] });
      if (path === '/batches' && method === 'POST') {
        if (fault === 'busy') await gate;
        const previous = body.request_id && batches.find(row => row.id === body.request_id);
        if (previous) return previous.creation_request === JSON.stringify(body) && previous.revision === 1
          ? reply({ batch: previous }) : route.fulfill({ status: 409, json: { detail: 'W1 创建冲突' } });
        const batch = { id: body.request_id ?? 'w1-batch-' + (batches.length + 1), creation_request: JSON.stringify(body), owner_id: user.id, revision: 1, name: body.name, mode: body.mode, customer_name: '', customer_code: '', uncoded: true, salesperson: '', items: [], created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', adjusted: false };
        batches.push(batch);
        if (fault === 'create-response-lost' && !injected) { injected = true; return route.abort('failed'); }
        return reply({ batch });
      }
      const match = path.match(/^\/batches\/([^/]+)\/(draft|calculate)$/);
      if (match && (method === 'PUT' || method === 'POST')) {
        const batch = batches.find(row => row.id === match[1]);
        assert.ok(batch);
        const signature = JSON.stringify([match[2], body]);
        if (body.request_id && batch.last_request?.id === body.request_id) return batch.last_request.signature === signature && batch.last_request.revision === batch.revision
          ? reply({ batch }) : route.fulfill({ status: 409, json: { detail: 'W1 重试冲突' } });
        if ((fault === 'draft-failed' && match[2] === 'draft' || fault === 'calculate-failed' && match[2] === 'calculate') && !injected) {
          injected = true;
          return route.fulfill({ status: 500, json: { detail: 'W1 合成中断' } });
        }
        if (body.revision !== batch.revision) return route.fulfill({ status: 409, json: { detail: 'W1 版本冲突' } });
        if (match[2] === 'draft') Object.assign(batch, body);
        else batch.items = batch.items.map(item => ({ ...item, product, cost: '4', result: { normal_price: '6.92', break_even_price: '6.29' }, trial_id: 'w1-trial' }));
        batch.revision++;
        if (body.request_id) batch.last_request = { id: body.request_id, signature, revision: batch.revision };
        if (fault === 'calculate-response-lost' && match[2] === 'calculate' && !injected) { injected = true; return route.abort('failed'); }
        return reply({ batch });
      }
      unexpected.push(method + ' ' + path);
      return route.fulfill({ status: 501, json: { detail: 'Unexpected W1 request' } });
    });
    try {
      await page.goto(origin + 'w1-baseline?page=' + pageName);
      if (pageName === 'estimator') {
        await page.getByRole('button', { name: '手工成本', exact: true }).click();
        const evaluated = page.waitForResponse(response => response.url().endsWith('/calculator/evaluate')
          && response.request().postDataJSON()?.source.kind === 'manual' && response.request().postDataJSON()?.source.cost === '4');
        await page.getByLabel('手工产品成本', { exact: true }).fill('4');
        await evaluated;
      } else {
        await page.getByRole('button', { name: product.code, exact: true }).click();
        await page.getByRole('button', { name: '开始报价', exact: true }).click();
        await page.getByLabel('客户名称', { exact: true }).fill('合成客户甲');
        await page.getByLabel('业务员', { exact: true }).fill('合成业务员甲');
      }
      await check({ page, batches, writes });
      assert.deepEqual(errors, [], 'browser runtime errors');
      assert.deepEqual(unexpected, [], 'unexpected requests');
      results.push({ name, status: 'passed', seconds: +((performance.now() - started) / 1000).toFixed(3), batches: batches.map(({ id, revision }) => ({ id, revision })), writes });
    } catch (error) {
      results.push({ name, status: 'failed', seconds: +((performance.now() - started) / 1000).toFixed(3), error: error.message, batches: batches.map(({ id, revision }) => ({ id, revision })), writes, errors, unexpected });
    } finally { release(); await page.close(); }
  }
  if (['smoke', 'all'].includes(values.scenario)) {
    await run('drawer-cancel-retains-input', async ({ page }) => {
      await page.getByRole('button', { name: '关闭详情', exact: true }).click();
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), '合成客户甲');
      await page.getByRole('button', { name: '保存报价', exact: true }).click();
      await page.getByRole('button', { name: '确认采用', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).isEnabled(), true);
    });
    await run('calculator-cancel-retains-manual-cost', async ({ page, writes }) => {
      await page.evaluate(() => { window.w1LeaveResult = null; void window.w1Leave().then(value => { window.w1LeaveResult = value; }); });
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      await page.waitForFunction(() => window.w1LeaveResult === false);
      assert.equal(await page.getByLabel('手工产品成本', { exact: true }).inputValue(), '4');
      assert.ok(writes.length > 0 && writes.every(row => row.path === '/calculator/evaluate'));
    }, '', 'estimator');
  }
  if (['exits', 'all'].includes(values.scenario)) {
    await run('unified-dirty-exit', async ({ page }) => {
      await page.evaluate(() => { window.w1LeaveResult = null; void window.w1Leave().then(value => { window.w1LeaveResult = value; }); });
      await page.waitForFunction(() => window.w1LeaveResult !== null || document.querySelector('[role="alertdialog"]'));
      assert.notEqual(await page.evaluate(() => window.w1LeaveResult), true, 'dirty quote bypassed unified navigation guard');
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      await page.waitForFunction(() => window.w1LeaveResult === false);
      assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), '合成客户甲');
    });
    await run('unified-busy-exit', async ({ page }) => {
      const entered = page.waitForRequest(request => request.url().endsWith('/batches') && request.method() === 'POST');
      await page.getByRole('button', { name: '保存报价', exact: true }).click();
      await entered;
      assert.equal(await page.evaluate(() => window.w1Leave()), false, 'busy quote bypassed unified navigation guard');
    }, 'busy');
  }
  if (['interruptions', 'all'].includes(values.scenario)) {
    for (const fault of ['draft-failed', 'calculate-failed', 'create-response-lost', 'calculate-response-lost']) {
      await run(fault, async ({ page, batches }) => {
        await page.getByRole('button', { name: '保存报价', exact: true }).click();
        await page.getByRole('alert').waitFor();
        assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), '合成客户甲');
        assert.equal(batches.length, 1, 'injection must occur after a simulated commit');
        await page.getByRole('button', { name: '保存报价', exact: true }).click();
        await page.getByRole('button', { name: '确认采用', exact: true }).waitFor();
        assert.equal(batches.length, 1, 'retry created a duplicate quote object');
      }, fault);
    }
  }
} finally { await browser?.close(); await server.close(); }
console.log(JSON.stringify({ scenario: values.scenario, environment: 'mock-api-no-database', results }, null, 2));
if (results.some(row => row.status === 'failed')) process.exitCode = 1;
