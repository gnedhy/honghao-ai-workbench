import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

// Started only by the isolated pytest fixture. No default port or production proxy.
const api = new URL(process.env.W2_TEST_API ?? '');
assert.equal(api.hostname, '127.0.0.1');
assert.ok(api.port && api.port !== '8000');
assert.equal(typeof process.env.W2_TEST_PASSWORD, 'string');
const base = '/api/workbenches/sales';
const entry = process.cwd().replaceAll('\\', '/') + '/w2-recovery.tsx';
const baselineSource = process.env.W2_BASELINE === '1' ? execFileSync('git', ['show', '17b22796adaa532d9a97416f3f23e9cf5fa168f9:src/workbenches/SalesWorkbench.tsx'], { encoding: 'utf8' }) : null;
const source = `import {createElement as h,useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/App';
import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';
import {confirmWorkbenchLeave} from '/src/components/interactionNavigation';
import '/src/styles.css';
window.w2Leave=confirmWorkbenchLeave;
function Host({user}){const [page,setPage]=useState(new URLSearchParams(location.search).has('existing')?'quotes':'calculate');return h(SalesWorkbench,{accessLevel:4,currentUser:user,page,onPageChange:async next=>{if(await confirmWorkbenchLeave())setPage(next)},view:'full',onEnter:()=>{}})}
fetch('/api/me').then(r=>r.json()).then(user=>{const root=createRoot(document.getElementById('root'));window.w2Unmount=()=>root.unmount();root.render(new URLSearchParams(location.search).has('app')?h(App,{currentUser:user,onLogout:()=>{},onUserChanged:()=>{},onPasswordChanged:()=>{}}):h(Host,{user}));});`;
const server = await createServer({ configFile: false, logLevel: 'silent', cacheDir: '.scratch/w2-20261002/vite-cache', plugins: [react(), {
  name: 'w2-sales-recovery',
  enforce: 'pre',
  configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/')) { res.statusCode = 503; res.end('Isolated interception required'); return; }
      if (path !== '/w2-recovery') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await instance.transformIndexHtml(path, '<html><body><div id="root"></div><script type="module" src="/w2-recovery.tsx"></script></body></html>'));
    });
  },
  resolveId(id) { if (id === '/w2-recovery.tsx' || id === entry) return entry; },
  load(id) { if (id === entry) return source; if (baselineSource && id.replaceAll('\\', '/').endsWith('/src/workbenches/SalesWorkbench.tsx')) return baselineSource; },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls.local[0];
  async function run(name, fault, check, app = false, existing = false) {
    if (process.env.W4_QUOTE_ONLY === '1' && !name.startsWith('w4-')) return;
    const started = performance.now();
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [], writes = [];
    let injected = false, release, closing = false;
    const gate = new Promise(resolve => { release = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    const login = async () => { const r = await context.request.post(new URL('/api/login', api).href, { data: { username: 'test-admin', password: process.env.W2_TEST_PASSWORD } }); assert.equal(r.status(), 200); };
    const health = await context.request.get(new URL('/api/health', api).href);
    assert.equal((await health.json()).environment, 'test');
    await login();
    const get = async path => { const r = await context.request.get(new URL(path, api).href); assert.equal(r.status(), 200); return r.json(); };
    const send = async (path, data, method = 'POST') => { const r = await context.request.fetch(new URL(path, api).href, { method, data }); assert.equal(r.status(), 200); return r.json(); };
    const before = new Set((await get(base + '/batches')).batches.map(row => row.id));
    let original;
    if (existing === 'snapshot') {
      original = (await get(base + '/batches/' + process.env.W4_SNAPSHOT_BATCH)).batch;
      before.delete(original.id);
    } else if (existing) {
      const created = (await send(base + '/batches', { name: 'W2 existing', mode: 'domestic_direct' })).batch;
      const items = [{ product_id: 'research:recipe:Q' }, ...(existing === 'partial' ? [{ product_id: 'research:composite:CF401B:CF026K+CF020D', parameters: { allocation: '.3' } }] : [])];
      const saved = (await send(base + '/batches/' + created.id + '/draft', { revision: 1, name: created.name, mode: created.mode, customer_name: 'W2 existing', salesperson: 'W2 合成销售', uncoded: true, items }, 'PUT')).batch;
      original = existing === 'draft' ? saved : (await send(base + '/batches/' + created.id + '/calculate', { revision: saved.revision, product_ids: items.map(row => row.product_id) })).batch;
      if (existing === 'partial') original = (await send(base + '/batches/' + created.id + '/adopt', { revision: original.revision, product_ids: ['research:recipe:Q'] })).batch;
    }
    await page.route('**/*', async route => {
      try {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin, new URL(origin).origin);
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const stage = req.method() === 'GET' ? '' : url.pathname === base + '/batches' ? 'create' : url.pathname.endsWith('/draft') ? 'draft' : url.pathname.endsWith('/calculate') ? 'calculate' : '';
      if (req.method() !== 'GET' && stage) {
        writes.push({ stage, revision: req.postDataJSON()?.revision ?? null });
        if (fault === 'busy' && stage === 'create') await gate;
        if (fault === stage + '-failed' && !injected) {
          injected = true;
          return route.fulfill({ status: 500, json: { detail: 'W2 合成中断' } });
        }
        if (fault === 'session-revoked' && stage === 'calculate' && !injected) {
          injected = true;
          const revoked = await context.request.post(new URL('/api/logout', api).href);
          assert.ok([200, 204].includes(revoked.status()));
        }
      }
      const response = await route.fetch({ url: new URL(url.pathname + url.search, api).href });
      if (stage && writes.length) writes.at(-1).status = response.status();
      if (stage && fault === stage + '-response-lost' && !injected) {
        assert.equal(response.status(), 200); // The real transaction committed before the response is dropped.
        injected = true;
        return route.abort('failed');
      }
      return route.fulfill({ response });
      } catch (error) { if (!closing) errors.push(error.message.split('\n')[0]); }
    });
    try {
      await page.goto(origin + 'w2-recovery' + (app ? '?app=1' : existing ? '?existing=1' : ''));
      if (app) {
        await page.getByRole('button', { name: /销售部.*产品报价管理/ }).click();
        await page.getByRole('button', { name: '进入工作台', exact: true }).click();
        await page.getByRole('button', { name: '产品报价', exact: true }).click();
      }
      if (existing) {
        await page.getByRole('button').filter({ hasText: original.customer_name }).first().click();
        await page.getByRole('button', { name: '继续报价', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Q', exact: true }).click();
        await page.getByRole('button', { name: '开始报价', exact: true }).click();
      }
      if (existing !== 'partial' && existing !== 'snapshot' && existing !== 'draft') {
        await page.getByLabel('客户名称', { exact: true }).fill('W2 合成客户');
        await page.getByLabel('业务员', { exact: true }).fill('W2 合成销售');
      }
      await check({ page, context, get, send, original, release, writes });
      assert.deepEqual(errors, []);
      if (fault === 'session-revoked') await login(); // Read-only inspection after proving retries stay unauthorized.
      const batches = (await get(base + '/batches')).batches.filter(row => !before.has(row.id));
      assert.equal(batches.length, ['actual-app-dirty-exits', 'pending-confirmation-unmount'].includes(name) ? 0 : 1, 'one quote object per attempted save');
      const detail = batches.length === 1 ? await get(base + '/batches/' + batches[0].id) : null;
      const trials = (await get(base + '/history')).trials.filter(row => batches.some(batch => batch.id === row.batch_id));
      if (detail && ['draft-failed', 'calculate-failed', 'create-response-lost', 'draft-response-lost', 'calculate-response-lost', 'busy-double-click-and-leave', 'validation-failed-then-corrected'].includes(name)) {
        assert.equal(detail.batch.revision, 3); assert.equal(trials.length, 1); assert.equal(detail.events.length, 3);
      }
      const recoveryCounts = {
        'lost-response-then-input-changed': [5, 2, 5],
        'session-revoked-stops-retry': [2, 0, 2],
        'existing-version-conflict-preserves-input': [4, 1, 4],
        'existing-interruption-revert-does-not-open-adoption': [7, 3, 7],
      };
      if (recoveryCounts[name]) assert.deepEqual([detail.batch.revision, trials.length, detail.events.length], recoveryCounts[name]);
      results.push({ name, status: 'passed', batches: batches.length, id: detail?.batch.id, revision: detail?.batch.revision, trials: trials.length, events: detail?.events.length, writes, milliseconds: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message, alerts: await page.getByRole('alert').allTextContents(), writes, milliseconds: Math.round(performance.now() - started) });
    } finally { closing = true; release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); }
  }
  for (const fault of ['draft-failed', 'calculate-failed', 'create-response-lost', 'draft-response-lost', 'calculate-response-lost']) {
    await run(fault, fault, async ({ page, get }) => {
      await page.getByRole('button', { name: '保存报价', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: /中断|Failed to fetch/ }).waitFor();
      assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
      await page.getByRole('button', { name: '保存报价', exact: true }).click();
      await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
      const batches = (await get(base + '/batches')).batches;
      // Count this scenario's new objects through the intercepted creation requests below.
      const newest = batches[0];
      assert.equal(newest.revision, 3);
      const detail = await get(base + '/batches/' + newest.id);
      assert.deepEqual(detail.events.map(row => row.kind), ['create', 'save_draft', 'calculate']);
    });
  }
  await run('busy-double-click-and-leave', 'busy', async ({ page, release, writes }) => {
    const request = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/batches'));
    await page.getByRole('button', { name: '保存报价', exact: true }).evaluate(button => { button.click(); button.click(); });
    await request;
    assert.equal(await page.evaluate(() => window.w2Leave()), false);
    assert.equal(await page.getByLabel('客户名称', { exact: true }).evaluate(el => !!el.closest('[inert],fieldset:disabled')), true);
    await assert.rejects(page.getByLabel('客户名称', { exact: true }).click({ timeout: 500 }), /intercepts pointer events/);
    await page.keyboard.type('busy overwrite');
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
    await page.getByRole('button', { name: '报价历史', exact: true }).evaluate(button => button.click());
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '报价明细', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '关闭详情', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '保存中…', exact: true }).isDisabled(), true);
    await page.screenshot({ path: '.scratch/w2-20261002/quote-busy.png' });
    const unload = await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); return window.dispatchEvent(event); });
    assert.equal(unload, false);
    assert.equal(writes.filter(row => row.stage === 'create').length, 1);
    release();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
  }, true);
  await run('validation-failed-then-corrected', '', async ({ page }) => {
    await page.getByLabel('业务员', { exact: true }).fill('X'.repeat(101));
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.getByLabel('业务员', { exact: true }).fill('W2 合成销售');
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
  });
  await run('lost-response-then-input-changed', 'calculate-response-lost', async ({ page, get }) => {
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.getByLabel('客户名称', { exact: true }).fill('W2 修改后客户');
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 修改后客户');
    const batch = (await get(base + '/batches')).batches[0];
    assert.equal(batch.customer_name, 'W2 修改后客户'); assert.equal(batch.revision, 5);
    assert.equal((await get(base + '/batches/' + batch.id)).events.length, 5);
    assert.equal((await get(base + '/history')).trials.filter(row => row.batch_id === batch.id).length, 2);
  });
  await run('session-revoked-stops-retry', 'session-revoked', async ({ page, writes }) => {
    const firstDenied = page.waitForResponse(response => response.url().endsWith('/calculate') && response.status() === 401);
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await firstDenied;
    await page.getByRole('alert').waitFor();
    const secondDenied = page.waitForResponse(response => response.url().endsWith('/calculate') && response.status() === 401);
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await secondDenied;
    await page.getByRole('alert').waitFor();
    await page.getByRole('button', { name: '保存报价', exact: true }).waitFor();
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
    assert.equal(writes.filter(row => row.stage === 'create').length, 1);
    assert.equal(writes.filter(row => row.stage === 'draft').length, 1);
    assert.equal(writes.filter(row => row.stage === 'calculate').length, 2);
  });
  await run('existing-version-conflict-preserves-input', '', async ({ page, send, get, original, writes }) => {
    const draft = { revision: original.revision, name: original.name, mode: original.mode, customer_name: 'W2 其他操作', salesperson: original.salesperson, uncoded: true, items: original.items };
    await send(base + '/batches/' + original.id + '/draft', draft, 'PUT');
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /其他操作更新/ }).waitFor();
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('button', { name: '保存报价', exact: true }).waitFor();
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
    const latest = (await get(base + '/batches/' + original.id)).batch;
    assert.equal(latest.customer_name, 'W2 其他操作'); assert.equal(latest.revision, 4);
    assert.ok(writes.length === 2 && writes.every(row => row.stage === 'draft' && row.revision === 3));
  }, false, true);
  await run('existing-interruption-revert-does-not-open-adoption', 'calculate-failed', async ({ page, get, original }) => {
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.getByLabel('客户名称', { exact: true }).fill(original.customer_name);
    assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).count(), 0);
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
    const latest = (await get(base + '/batches/' + original.id)).batch;
    assert.equal(latest.customer_name, original.customer_name); assert.equal(latest.revision, 7);
  }, false, true);
  await run('actual-app-dirty-exits', '', async ({ page }) => {
    await page.screenshot({ path: '.scratch/w2-20261002/quote-editor.png', animations: 'disabled' });
    // showModal makes background navigation inert: these are not reachable drawer exits.
    await assert.rejects(page.getByRole('button', { name: '报价历史', exact: true }).click({ timeout: 500 }), /intercepts pointer events/);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.mouse.click(8, 400);
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    const refreshed = new Promise(resolve => page.once('dialog', async dialog => { assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss(); resolve(); }));
    await page.evaluate(() => location.reload());
    await refreshed;
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
    for (const label of ['报价历史', '返回主页']) {
      await page.getByRole('button', { name: label, exact: true }).evaluate(button => button.click());
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), 'W2 合成客户');
    }
    await page.evaluate(() => { window.w2Exit = window.w2Leave(); window.w2SecondExit = window.w2Leave(); });
    await page.getByRole('button', { name: '继续编辑', exact: true }).waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 1);
    assert.equal(await page.evaluate(() => window.w2SecondExit), false);
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await page.evaluate(() => window.w2Exit), false);
    await page.evaluate(() => { window.w2Exit = window.w2Leave(); });
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    assert.equal(await page.evaluate(() => window.w2Exit), true);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('dialog', { name: '报价明细', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.w2Leave()), true);
    await page.getByRole('button', { name: '测算工具', exact: true }).click();
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    const evaluated = page.waitForResponse(response => response.url().endsWith('/calculator/evaluate') && response.request().postDataJSON()?.source.cost === '4');
    await page.getByLabel('手工产品成本', { exact: true }).fill('4');
    await evaluated;
    await page.getByRole('button', { name: '报价历史', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await page.getByLabel('手工产品成本', { exact: true }).inputValue(), '4');
    await page.getByRole('button', { name: '报价历史', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('heading', { name: '报价历史', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.w2Leave()), true);
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), true);
    await page.getByRole('button', { name: '返回主页', exact: true }).click();
    await page.getByRole('heading', { name: '职能工作台', exact: true }).waitFor();
    await page.getByRole('button', { name: /采购部.*原料价格管理/ }).click();
    await page.getByRole('heading', { name: '原料价格管理', exact: true }).waitFor();
  }, true);
  await run('pending-confirmation-unmount', '', async ({ page }) => {
    await page.evaluate(() => { window.w2Exit = window.w2Leave(); });
    await page.getByRole('alertdialog').waitFor();
    await page.evaluate(() => window.w2Unmount());
    assert.equal(await page.evaluate(() => window.w2Exit), false);
    assert.equal(await page.evaluate(() => window.w2Leave()), true);
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), true);
  });
  await run('w4-adopt-then-add-product', '', async ({ page, get }) => {
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    const batch = (await get(base + '/batches')).batches[0];
    const frozen = structuredClone(batch.items[0]);
    for (const name of ['客户名称', '客户编码', '业务员']) assert.equal(await page.getByLabel(name, { exact: true }).isDisabled(), true);
    const adopted = page.getByRole('dialog', { name: '报价明细', exact: true }).locator('article');
    await adopted.getByRole('button', { name: '报价调整', exact: true }).click();
    assert.equal(await adopted.getByLabel('运费（元）', { exact: true }).isDisabled(), true);
    assert.equal(await adopted.getByRole('button', { name: '库存优先', exact: true }).isDisabled(), true);
    await page.screenshot({ path: '.scratch/w4-20261002/quote-adopted.png', animations: 'disabled' });
    await page.getByLabel('添加产品', { exact: true }).click();
    await page.getByRole('button', { name: /^CF401B 最新优先/ }).click();
    const added = page.getByRole('dialog', { name: '报价明细', exact: true }).locator('article').filter({ hasText: 'CF401B' });
    await added.getByRole('button', { name: '报价调整', exact: true }).click();
    await added.getByLabel('特殊公摊（元）', { exact: true }).fill('0.3');
    await added.getByLabel('利润系数', { exact: true }).fill('1.2');
    await added.getByLabel('最终报价（元/kg）', { exact: true }).fill('20');
    await added.getByLabel('客户议价', { exact: true }).check();
    await page.getByRole('button', { name: '批量报价调整', exact: true }).click();
    await page.getByLabel('运费（元）', { exact: true }).first().fill('0.7');
    await page.getByRole('button', { name: '应用到全部产品', exact: true }).click();
    await page.getByText('尚未保存', { exact: true }).waitFor();
    await page.screenshot({ path: '.scratch/w4-20261002/quote-bulk.png', animations: 'disabled' });
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
    const saved = (await get(base + '/batches/' + batch.id)).batch;
    assert.deepEqual(saved.items.find(row => row.product_id === frozen.product_id), frozen);
    assert.equal(saved.items.length, 2);
    const pending = saved.items.find(row => !row.adopted);
    assert.equal(pending.parameters.freight, '0.7'); assert.equal(pending.parameters.profit, '1.2');
    assert.equal(pending.parameters.allocation, '0.3'); assert.equal(pending.final_price, '20.00');
  });
  await run('w4-partial-continue-save', '', async ({ page, get, original }) => {
    const frozen = original.items.find(row => row.adopted);
    await page.getByRole('button', { name: '报价调整', exact: true }).click();
    await page.getByLabel('运费（元）', { exact: true }).fill('0.7');
    await page.getByLabel('客户议价', { exact: true }).check();
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
    const saved = (await get(base + '/batches/' + original.id)).batch;
    assert.deepEqual(saved.items.find(row => row.product_id === frozen.product_id), frozen);
    assert.equal(saved.items.find(row => !row.adopted).parameters.freight, '0.7');
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    const records = (await get(base + '/records')).records.filter(row => row.batch_id === original.id);
    assert.equal(records.length, 2);
    assert.ok(records.every(row => row.version === 1));
  }, false, 'partial');
  await run('w4-reopen-saved-cost-snapshot', '', async ({ page, get, original }) => {
    assert.equal((await get(base + '/products')).products.find(row => row.code === 'Q').latest_cost, '12');
    assert.equal(original.items[0].cost, '4');
    await page.getByRole('dialog', { name: '报价明细', exact: true }).locator('article').getByText('6.92', { exact: false }).waitFor();
    await page.getByRole('button', { name: '报价调整', exact: true }).click();
    await page.getByLabel('运费（元）', { exact: true }).fill('0.4');
    await page.getByLabel('客户议价', { exact: true }).check();
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor();
    const saved = (await get(base + '/batches/' + original.id)).batch;
    assert.equal(saved.items[0].cost, '4');
    assert.equal(saved.items[0].final_price, '7.05');
    await page.getByRole('dialog', { name: '报价明细', exact: true }).locator('article').getByText('7.05', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).isDisabled(), true);
    await page.getByLabel('保留本次成本依据', { exact: false }).check();
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    const record = (await get(base + '/records')).records.find(row => row.batch_id === original.id);
    assert.equal(record.item.cost, '4'); assert.equal(record.item.final_price, '7.05');
  }, false, 'snapshot');
  await run('w4-dirty-reopen-revise-code-and-void', '', async ({ page, get, send }) => {
    const save = async () => { await page.getByRole('button', { name: '保存报价', exact: true }).click(); await page.getByText('报价已保存，可继续确认采用', { exact: true }).waitFor(); };
    const changed = async () => { assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).count(), 0); await page.getByText('尚未保存', { exact: true }).waitFor(); await save(); };
    await save();
    await page.getByLabel('客户名称', { exact: true }).fill('W4 生命周期客户'); await changed();
    await page.getByLabel('客户类型', { exact: true }).click();
    await page.getByRole('button', { name: '外贸直接厂', exact: true }).click(); await changed();
    await page.getByLabel('客户类型', { exact: true }).click();
    await page.getByRole('button', { name: '国内直接厂', exact: true }).click(); await changed();
    await page.getByRole('button', { name: '报价调整', exact: true }).click();
    await page.getByLabel('运费（元）', { exact: true }).fill('0.4'); await changed();
    await page.getByRole('button', { name: '库存优先', exact: true }).click(); await changed();
    await page.getByRole('button', { name: '报价调整', exact: true }).click();
    await page.getByLabel('最终报价（元/kg）', { exact: true }).fill('0');
    await page.getByLabel('客户议价', { exact: true }).check(); await changed();
    assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).isDisabled(), true);
    await page.getByLabel('确认低于盈亏平衡参考价', { exact: false }).check();
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    let batch = (await get(base + '/batches')).batches[0];
    const first = (await get(base + '/records')).records.find(row => row.batch_id === batch.id);
    assert.equal(first.item.final_price, '0.00'); assert.equal(first.version, 1);
    await page.getByRole('button', { name: '稍后处理', exact: true }).click();
    await page.getByRole('button', { name: 'Q', exact: true }).click();
    await page.getByRole('button', { name: '开始报价', exact: true }).click();
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: '报价调整', exact: true }).click();
    assert.equal(await page.getByLabel('最终报价（元/kg）', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('确认低于盈亏平衡参考价', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '报价历史', exact: true }).click();
    await page.getByRole('button').filter({ hasText: batch.customer_name }).first().click();
    await page.getByRole('button', { name: '调整有效报价', exact: true }).click();
    await page.getByLabel('调整原因', { exact: true }).fill('W4 客户重新议价');
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('dialog', { name: '报价明细', exact: true }).waitFor();
    assert.equal(await page.getByLabel('客户名称', { exact: true }).inputValue(), batch.customer_name);
    assert.equal(await page.getByLabel('客户名称', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).count(), 0);
    // Revision cleared the calculation but changed no input: save and adopt directly.
    await save();
    await page.getByLabel('确认低于盈亏平衡参考价', { exact: false }).check();
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    await page.getByRole('button', { name: '稍后处理', exact: true }).click();
    await page.getByRole('button').filter({ hasText: batch.customer_name }).first().click();
    await page.getByRole('button', { name: '调整有效报价', exact: true }).click();
    await page.getByLabel('调整原因', { exact: true }).fill('W4 第三版议价');
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('dialog', { name: '报价明细', exact: true }).waitFor();
    await page.getByRole('button', { name: '报价调整', exact: true }).click();
    assert.equal(await page.getByLabel('最终报价（元/kg）', { exact: true }).isDisabled(), false);
    await page.getByLabel('最终报价（元/kg）', { exact: true }).fill('20'); await changed();
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    batch = (await get(base + '/batches/' + batch.id)).batch;
    batch = (await send(base + '/batches/' + batch.id + '/customer-code', { revision: batch.revision, customer_code: 'W4-K001' })).batch;
    const records = (await get(base + '/records')).records.filter(row => row.batch_id === batch.id);
    assert.deepEqual(records.map(row => row.version).sort(), [1, 2, 3]);
    assert.deepEqual(records.find(row => row.id === first.id).item, first.item);
    assert.equal(records.find(row => row.version === 2).item.final_price, '0.00');
    assert.equal(records.find(row => row.version === 3).item.final_price, '20.00');
    assert.ok(records.every(row => row.customer_code === '' && row.current_customer_code === 'W4-K001'));
    await page.getByRole('button', { name: '稍后处理', exact: true }).click();
    // Reload gets the explicit code-supplement revision before the next UI write.
    await page.reload();
    await page.getByRole('button', { name: /销售部.*产品报价管理/ }).click();
    await page.getByRole('button', { name: '进入工作台', exact: true }).click();
    await page.getByRole('button', { name: '报价历史', exact: true }).click();
    await page.getByRole('button').filter({ hasText: batch.customer_name }).first().click();
    await page.getByRole('button', { name: '作废有效报价', exact: true }).click();
    await page.getByLabel('作废原因', { exact: true }).fill('W4 合成作废');
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const final = (await get(base + '/records')).records.filter(row => row.batch_id === batch.id);
    assert.ok(final.every(row => row.status !== 'active'));
    assert.deepEqual(final.find(row => row.id === first.id).item, first.item);
  }, true);
  await run('w4-uncomputed-draft-reopen', '', async ({ page, get, original }) => {
    assert.equal(await page.getByRole('button', { name: '确认采用', exact: true }).count(), 0);
    await page.getByRole('button', { name: '保存报价', exact: true }).click();
    await page.getByRole('button', { name: '确认采用', exact: true }).click();
    await page.getByText('报价已采用并成为当前有效报价', { exact: true }).waitFor();
    const records = (await get(base + '/records')).records.filter(row => row.batch_id === original.id);
    assert.equal(records.length, 1); assert.equal(records[0].version, 1);
  }, false, 'draft');
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.some(row => row.status === 'failed') ? 1 : 0;
} finally { await browser?.close(); await server.close(); }
