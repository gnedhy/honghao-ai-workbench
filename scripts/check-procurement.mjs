import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const api = new URL(process.env.W6_TEST_API ?? '');
assert.equal(api.hostname, '127.0.0.1');
assert.ok(api.port && api.port !== '8000' && process.env.W6_TEST_PASSWORD);
const base = '/api/workbenches/procurement';
mkdirSync('.scratch/w6-20261003/browser', { recursive: true });
const entry = process.cwd().replaceAll('\\', '/') + '/w6-procurement.tsx';
const server = await createServer({ configFile: false, logLevel: 'silent', cacheDir: '.scratch/w6-20261003/vite-cache', plugins: [react(), {
  name: 'w6-procurement',
  configureServer(instance) { instance.middlewares.use(async (req, res, next) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) { res.statusCode = 503; res.end('Isolated interception required'); return; }
    if (path !== '/w6-procurement') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(await instance.transformIndexHtml(path, '<html><body><div id="root"></div><script type="module" src="/w6-procurement.tsx"></script></body></html>'));
  }); },
  resolveId(id) { if (id === '/w6-procurement.tsx' || id === entry) return entry; },
  load(id) { if (id === entry) return `import {createElement as h,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProcurementWorkbench} from '/src/workbenches/ProcurementWorkbench';
import {ResearchMaterialPrices} from '/src/workbenches/ResearchMaterialPrices';
import {confirmWorkbenchLeave} from '/src/components/interactionNavigation';
import '/src/styles.css';
function Host({user}){const [page,setPage]=useState(new URL(location.href).searchParams.has('readonly')?'research':'materials');const change=async next=>{if(await confirmWorkbenchLeave())setPage(next)};return h('main',null,h('button',{onClick:()=>change('research')},'切换研发原料'),h('button',{onClick:()=>change('materials')},'切换采购台账'),h('button',{onClick:()=>change('updates')},'切换本轮更新'),h('button',{onClick:()=>change('distribution')},'切换部门分流'),h('button',{onClick:()=>change('dashboard')},'切换采购概览'),h('button',{onClick:()=>setPage('research')},'测试强制卸载'),page==='research'?h(ResearchMaterialPrices,{userId:user.id}):h(ProcurementWorkbench,{accessLevel:user.is_system_admin?4:user.scope_levels.procurement??0,page,onPageChange:change,view:'full',onEnter:()=>{}}))}
fetch('/api/me').then(r=>r.json()).then(user=>createRoot(document.getElementById('root')).render(h(Host,{user})));`; },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const evidence = [];
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls.local[0];
  async function run(name, fault, check) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], writes = [], reads = [], pending = gate(), held = gate(), delivered = gate(); let injected = false, closing = false, overviewReads = 0, readonlyReads = 0, detailReads = 0, adjusted = false;
    page.on('pageerror', error => errors.push(error.message));
    const get = async path => { const r = await context.request.get(new URL(path, api).href); assert.equal(r.status(), 200); return r.json(); };
    const send = async (path, data, expected = 200) => { const r = await context.request.post(new URL(path, api).href, { data }); assert.equal(r.status(), expected, await r.text()); return r.json(); };
    assert.equal((await get('/api/health')).environment, 'test');
    await send('/api/login', { username: fault === 'readonly' ? 'w6-readonly' : 'test-admin', password: process.env.W6_TEST_PASSWORD });
    await page.route('**/*', async route => {
      try {
        const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, new URL(origin).origin);
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.ok(url.pathname === '/api/me' || url.pathname.startsWith('/api/workbenches/'));
        if (fault === 'readonly' && url.pathname.startsWith('/api/workbenches/')) {
          assert.ok(url.pathname.startsWith('/api/workbenches/research/material-prices')); assert.equal(req.method(), 'GET');
        }
        if (req.method() === 'GET') reads.push(url.pathname);
        else writes.push({ path: url.pathname, body: req.postDataJSON() });
        const saving = url.pathname === base + '/prices/bulk-adjustments' && req.method() === 'POST';
        const adjusting = url.pathname.endsWith('/adjustments') && req.method() === 'POST';
        if (saving && fault === 'save-failed' && !injected) { injected = true; return route.fulfill({ status: 500, json: { detail: 'W6 合成保存失败' } }); }
        if ((saving && fault === 'save-slow' || adjusting && fault === 'drawer-slow') && !injected) { injected = true; await pending.promise; }
        if (fault === 'readonly' && url.pathname === '/api/workbenches/research/material-prices') {
          readonlyReads++;
          if (readonlyReads === 1 || readonlyReads === 3) return route.fulfill({ status: 503, json: { detail: 'W6 合成读取失败' } });
        }
        if (fault === 'readonly' && url.pathname.startsWith('/api/workbenches/research/material-prices/')) {
          detailReads++;
          if (detailReads === 1 || detailReads === 3) return route.fulfill({ status: 503, json: { detail: 'W6 合成详情失败' } });
        }
        const response = await route.fetch({ url: new URL(url.pathname + url.search, api).href });
        if (fault === 'preferences-slow' && url.pathname === base + '/preferences' && req.method() === 'PUT') await new Promise(resolve => setTimeout(resolve, 500));
        if (adjusting) adjusted = true;
        const delayedOverview = fault === 'overview-slow' && url.pathname === base + '/overview' && ++overviewReads === 2;
        const delayedDetail = fault === 'drawer-refresh-slow' && adjusted && req.method() === 'GET' && url.pathname.startsWith(base + '/materials/');
        if (delayedOverview || delayedDetail) { held.release(); await pending.promise; }
        if (saving && fault === 'lost-save' && !injected) { injected = true; assert.equal(response.status(), 200); return route.abort('failed'); }
        await route.fulfill({ response });
        if (delayedOverview || delayedDetail) delivered.release();
      } catch (error) { if (!closing) errors.push(error.message); }
    });
    try {
      await page.goto(origin + 'w6-procurement' + (fault === 'readonly' ? '?readonly' : ''));
      await check({ page, get, send, pending, held, delivered, writes, reads });
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `.scratch/w6-20261003/browser/${name}.png`, fullPage: true });
      evidence.push({ name, status: 'passed', writes: writes.map(row => row.path) });
    } catch (error) {
      await page.screenshot({ path: `.scratch/w6-20261003/browser/${name}-failed.png`, fullPage: true });
      writeFileSync(`.scratch/w6-20261003/browser/${name}-failed.txt`, await page.locator('body').innerText());
      throw error;
    } finally { closing = true; pending.release(); await context.close(); }
  }
  async function edit(page, code, value) {
    await page.getByRole('button', { name: '编辑价格', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill(code);
    await page.getByRole('textbox', { name: code + '待发布价', exact: true }).fill(value);
  }
  async function confirm(page) {
    await page.getByRole('button', { name: /^保存修改/ }).click();
    const dialog = page.getByRole('dialog', { name: '保存价格修改' });
    await dialog.getByLabel('录价说明', { exact: true }).selectOption('供应商报价');
    await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
    return dialog;
  }
  await run('lost-save-response-reconciles-without-second-write', 'lost-save', async ({ page, get, writes }) => {
    await edit(page, 'W6-000', '11');
    const dialog = await confirm(page);
    await dialog.getByRole('button', { name: '读取最新数据核对（保留输入）', exact: true }).click();
    await dialog.getByText('已读取最新版本', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: '确认并保存', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认并保存', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'W6-000待发布价', exact: true }).inputValue(), '11');
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    assert.equal(writes.filter(row => row.path.endsWith('/prices/bulk-adjustments')).length, 1);
    const data = await get(base + '/overview');
    assert.equal(data.current_update.input_items.find(row => row.code === 'W6-000').draft_price, '11');
    assert.equal(data.materials.find(row => row.code === 'W6-000').published_price, '10');
  });
  await run('cross-page-sort-filter-zero-and-save', 'preferences-slow', async ({ page, get, writes }) => {
    await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: '显示' }).click();
    await page.getByRole('spinbutton', { name: '自定义每页条目数' }).fill('10');
    await page.getByRole('spinbutton', { name: '自定义每页条目数' }).press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 10);
    await page.getByRole('button', { name: '编辑价格', exact: true }).click();
    const order = () => page.locator('tbody tr td[data-column="identity"]').allTextContents();
    const before = await order();
    await page.getByRole('textbox', { name: 'W6-000待发布价', exact: true }).fill('0');
    assert.deepEqual(await order(), before);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    const second = page.getByRole('textbox', { name: /待发布价$/ }).first();
    const code = (await second.getAttribute('aria-label')).replace('待发布价', '');
    await second.fill('10.12345678');
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('W6-000');
    assert.equal(await page.getByRole('textbox', { name: 'W6-000待发布价', exact: true }).inputValue(), '0');
    await page.getByRole('textbox', { name: 'W6-000待发布价', exact: true }).fill('');
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill(code);
    await page.getByRole('button', { name: '原料编号', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('W6-000');
    assert.equal(await page.getByRole('textbox', { name: 'W6-000待发布价', exact: true }).inputValue(), '11');
    await page.getByRole('textbox', { name: 'W6-000待发布价', exact: true }).fill('0');
    await confirm(page);
    await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    const body = writes.find(row => row.path.endsWith('/prices/bulk-adjustments')).body;
    const state = await get(base + '/overview');
    assert.equal(body.items.length, 2);
    const values = Object.fromEntries(state.current_update.input_items.map(row => [row.code, row.draft_price]));
    assert.equal(values['W6-000'], '0'); assert.equal(values[code], '10.12345678');
    assert.equal(state.materials.find(row => row.code === 'W6-000').published_price, '10');
  });
  await run('save-failure-keeps-input-and-retry', 'save-failed', async ({ page, get, writes }) => {
    await edit(page, 'W6-001', '12');
    const dialog = await confirm(page);
    await dialog.getByText('W6 合成保存失败', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'W6-001待发布价', exact: true }).inputValue(), '12');
    await confirm(page); await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    assert.equal(writes.filter(row => row.path.endsWith('/prices/bulk-adjustments')).length, 2);
    assert.equal((await get(base + '/overview')).current_update.input_items.find(row => row.code === 'W6-001').draft_price, '12');
  });
  await run('conflict-recovery-preserves-own-and-other-input', '', async ({ page, get, send }) => {
    await edit(page, 'W6-001', '13');
    const old = await get(base + '/overview');
    const other = old.materials.find(row => row.code === 'W6-003');
    await send(base + '/prices/bulk-adjustments', { update_id: old.current_update.id, updated_at: old.current_update.updated_at, effective_date: old.current_update.price_date, reason: '合成并发改价', items: [{ material_id: other.id, price: '10.5' }] });
    const dialog = await confirm(page);
    await dialog.getByRole('button', { name: '读取最新数据核对（保留输入）', exact: true }).click();
    await dialog.getByText('已读取最新版本', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: '确认并保存', exact: true }).click();
    await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    const rows = (await get(base + '/overview')).current_update.input_items;
    assert.equal(rows.find(row => row.code === 'W6-001').draft_price, '13');
    assert.equal(rows.find(row => row.code === 'W6-003').draft_price, '10.5');
  });
  await run('stale-overview-cannot-erase-successful-save', 'overview-slow', async ({ page, pending, held, delivered, get }) => {
    await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    await page.getByRole('button', { name: '切换本轮更新', exact: true }).click();
    await held.promise;
    await edit(page, 'W6-001', '14'); await confirm(page);
    await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    pending.release(); await delivered.promise;
    await page.waitForTimeout(100);
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('W6-001');
    await page.locator('tbody td[data-column="draft_price"]').getByText('¥14', { exact: true }).waitFor();
    assert.equal((await get(base + '/overview')).current_update.input_items.find(row => row.code === 'W6-001').draft_price, '14');
  });
  await run('cancel-edit-and-busy-exit', 'save-slow', async ({ page, pending, writes }) => {
    await edit(page, 'W6-004', '11');
    await page.getByRole('button', { name: '切换研发原料', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'W6-004待发布价', exact: true }).inputValue(), '11');
    const dialog = await confirm(page);
    await dialog.getByRole('button', { name: '正在保存', exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => { const { confirmWorkbenchLeave } = await import('/src/components/interactionNavigation'); return confirmWorkbenchLeave(); }), false);
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
    pending.release(); await page.getByRole('button', { name: '编辑价格', exact: true }).waitFor();
    assert.equal(writes.filter(row => row.path.endsWith('/prices/bulk-adjustments')).length, 1);
    await page.getByRole('button', { name: '切换研发原料', exact: true }).click();
    await page.getByRole('heading', { name: '原料价格', exact: true, level: 1 }).waitFor();
  });
  await run('drawer-draft-switch-refresh-and-busy-save', 'drawer-slow', async ({ page, pending, get, writes }) => {
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('W6-002');
    await page.getByRole('button', { name: 'W6-002', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '原料价格详情', exact: true });
    await drawer.getByRole('button', { name: '录入新价格', exact: true }).click();
    const date = drawer.locator('input[type="date"]'); await date.fill('2026-09-10');
    let unload = 0; const refreshed = new Promise(resolve => page.once('dialog', async dialog => { assert.equal(dialog.type(), 'beforeunload'); unload++; await dialog.dismiss(); resolve(); }));
    await page.evaluate(() => location.reload()); await refreshed;
    assert.equal(unload, 1); assert.equal(await date.inputValue(), '2026-09-10');
    await drawer.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-10');
    await date.fill((await get(base + '/overview')).current_update.price_date);
    const price = drawer.getByRole('spinbutton', { name: '价格', exact: true }); await price.fill('12');
    await drawer.getByLabel('录价说明', { exact: true }).selectOption('供应商报价');
    await drawer.getByRole('button', { name: '确认并保存', exact: true }).click({ trial: true });
    await drawer.getByRole('button', { name: '确认并保存', exact: true }).evaluate(button => { button.click(); button.click(); });
    await drawer.getByRole('button', { name: '正在写入', exact: true }).waitFor();
    assert.equal(await price.isDisabled(), true); assert.equal(await date.isDisabled(), true);
    assert.equal(await drawer.getByRole('button', { name: '编辑资料', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(async () => { const { confirmWorkbenchLeave } = await import('/src/components/interactionNavigation'); return confirmWorkbenchLeave(); }), false);
    pending.release(); await drawer.waitFor({ state: 'detached' });
    assert.equal(writes.filter(row => row.path.endsWith('/adjustments')).length, 1);
    const state = await get(base + '/overview');
    assert.equal(state.current_update.input_items.find(row => row.code === 'W6-002').draft_price, '12');
    assert.equal(state.materials.find(row => row.code === 'W6-002').published_price, '10');
  });
  await run('drawer-refresh-completes-after-forced-unmount', 'drawer-refresh-slow', async ({ page, pending, held, delivered, reads }) => {
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('W6-005');
    await page.getByRole('button', { name: 'W6-005', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '原料价格详情', exact: true });
    await drawer.getByRole('button', { name: '录入新价格', exact: true }).click();
    await drawer.getByRole('spinbutton', { name: '价格', exact: true }).fill('11');
    await drawer.getByLabel('录价说明', { exact: true }).selectOption('供应商报价');
    await drawer.getByRole('button', { name: '确认并保存', exact: true }).click();
    await held.promise;
    const before = reads.filter(path => path === base + '/overview').length;
    await page.getByRole('button', { name: '测试强制卸载', exact: true }).evaluate(button => button.click());
    await drawer.waitFor({ state: 'detached' });
    pending.release(); await delivered.promise; await page.waitForTimeout(200);
    assert.equal(reads.filter(path => path === base + '/overview').length, before);
  });
  await run('review-draft-double-submit-and-enable-boundary', '', async ({ page, get, send, writes }) => {
    const old = await get(base + '/overview'), item = old.materials.find(row => row.code === 'A');
    await send(base + '/prices/bulk-adjustments', { update_id: old.current_update.id, updated_at: old.current_update.updated_at, effective_date: old.current_update.price_date, reason: '合成大幅改价', items: [{ material_id: item.id, price: '60' }] });
    await page.getByRole('button', { name: '切换本轮更新', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('A');
    await page.getByRole('button', { name: '确认波动', exact: true }).first().click();
    const region = page.getByRole('region', { name: 'A价格波动确认', exact: true });
    await region.getByLabel('A确认依据', { exact: true }).selectOption('other');
    const reason = region.getByRole('textbox', { name: 'A确认依据其他原因', exact: true }); await reason.fill('合成供应商核对依据');
    await page.getByRole('button', { name: '切换研发原料', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await reason.inputValue(), '合成供应商核对依据');
    await region.getByRole('button', { name: '确认波动', exact: true }).evaluate(button => { button.click(); button.click(); });
    await region.waitFor({ state: 'detached' });
    assert.equal(writes.filter(row => row.path.endsWith('/review')).length, 1);
    await page.getByRole('textbox', { name: '搜索原料', exact: true }).fill('W6-002');
    await page.getByRole('button', { name: '确认波动', exact: true }).click();
    const prior = page.getByRole('region', { name: 'W6-002价格波动确认', exact: true });
    await prior.getByLabel('W6-002确认依据', { exact: true }).selectOption('other');
    await prior.getByRole('textbox', { name: 'W6-002确认依据其他原因', exact: true }).fill('合成详情改价核对依据');
    await prior.getByRole('button', { name: '确认波动', exact: true }).click();
    await prior.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '启用价格', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '启用价格', exact: true });
    assert.equal((await get(base + '/overview')).materials.find(row => row.code === 'A').published_price, '30');
    await dialog.getByRole('button', { name: '确认启用', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
    assert.equal(writes.filter(row => row.path.endsWith('/review')).length, 2);
    assert.equal((await get(base + '/overview')).materials.find(row => row.code === 'A').published_price, '60');
    await page.getByRole('button', { name: '切换研发原料', exact: true }).click();
    await page.getByRole('button', { name: 'A', exact: true }).waitFor();
    assert.equal((await get('/api/workbenches/research/material-prices')).materials.find(row => row.code === 'A').published_price, '60');
  });
  await run('distribution-ledger-and-ranking-consumers', '', async ({ page, writes }) => {
    await page.getByRole('button', { name: '切换部门分流', exact: true }).click();
    await page.getByRole('button', { name: '查看明细', exact: true }).first().click();
    await page.getByRole('button', { name: 'A', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '原料价格详情', exact: true });
    await drawer.getByText('¥60', { exact: true }).first().waitFor();
    await drawer.getByRole('button', { name: '录入新价格', exact: true }).waitFor();
    await page.screenshot({ path: '.scratch/w6-20261003/browser/distribution-writable-detail.png', fullPage: true });
    await drawer.getByRole('button', { name: '关闭详情', exact: true }).click(); await drawer.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'A', exact: true }).evaluate(button => document.activeElement === button), true);
    await page.getByRole('button', { name: '调整范围', exact: true }).click();
    await page.locator('summary').filter({ hasText: '显示' }).click();
    await page.getByRole('spinbutton', { name: '自定义每页条目数' }).fill('10');
    await page.getByRole('spinbutton', { name: '自定义每页条目数' }).press('Enter');
    const first = page.getByRole('checkbox', { name: /^关联 / }).first();
    const label = await first.getAttribute('aria-label'); const old = await first.isChecked();
    await first.setChecked(!old);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: label, exact: true }).isChecked(), !old);
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.getByRole('button', { name: '切换采购概览', exact: true }).click();
    const ranking = page.getByRole('region', { name: '价格变动排行', exact: true });
    await ranking.getByRole('button', { name: 'A', exact: true }).first().click();
    await drawer.getByText('¥60', { exact: true }).first().waitFor();
    assert.equal(await drawer.getByRole('button', { name: '录入新价格', exact: true }).count(), 0);
    await page.screenshot({ path: '.scratch/w6-20261003/browser/ranking-readonly-detail.png', fullPage: true });
    await drawer.getByRole('button', { name: '关闭详情', exact: true }).click(); await drawer.waitFor({ state: 'detached' });
    assert.equal(await ranking.getByRole('button', { name: 'A', exact: true }).first().evaluate(button => document.activeElement === button), true);
    assert.equal(writes.filter(row => !row.path.endsWith('/preferences')).length, 0);
  });
  await run('research-readonly-scope-failures-refresh-and-cleanup', 'readonly', async ({ page, get, reads, writes }) => {
    await page.getByRole('button', { name: '重试', exact: true }).click();
    const state = await get('/api/workbenches/research/material-prices');
    await page.getByRole('button', { name: 'A', exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), state.materials.filter(row => row.in_formula_scope).length);
    assert.equal(await page.getByRole('button', { name: 'W6-000', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'A', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '原料价格详情', exact: true });
    await drawer.getByRole('button', { name: '重新加载', exact: true }).click();
    await drawer.getByText('¥60', { exact: true }).first().waitFor();
    assert.equal(await drawer.getByRole('button', { name: '录入新价格', exact: true }).count(), 0);
    await page.waitForTimeout(10500);
    await drawer.getByText('价格更新失败，当前显示上次读取的内容。', { exact: false }).waitFor();
    await page.screenshot({ path: '.scratch/w6-20261003/browser/research-readonly-refresh-failed.png', fullPage: true });
    await drawer.getByRole('button', { name: '重试', exact: true }).click();
    await drawer.getByText('¥60', { exact: true }).first().waitFor();
    await drawer.getByRole('button', { name: '关闭详情', exact: true }).click(); await drawer.waitFor({ state: 'detached' });
    const before = reads.filter(path => path.startsWith('/api/workbenches/research/material-prices/')).length;
    await page.waitForTimeout(10500);
    assert.equal(reads.filter(path => path.startsWith('/api/workbenches/research/material-prices/')).length, before);
    assert.deepEqual(writes, []);
    assert.equal(await page.getByRole('button', { name: 'A', exact: true }).evaluate(button => document.activeElement === button), true);
  });
  process.stdout.write(JSON.stringify(evidence));
} finally { await browser?.close(); await server.close(); }
