import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

// Only the authenticated, fixture-owned API; no default port or production proxy.
const api = new URL(process.env.W5_TEST_API ?? '');
assert.equal(api.hostname, '127.0.0.1');
assert.ok(api.port && api.port !== '8000');
assert.ok(process.env.W5_TEST_PASSWORD);
const base = '/api/workbenches/sales/calculator';
mkdirSync('.scratch/w5-20261003/browser', { recursive: true });
const entry = process.cwd().replaceAll('\\', '/') + '/w5-calculator.tsx';
const server = await createServer({ configFile: false, logLevel: 'silent', cacheDir: '.scratch/w5-20261003/vite-cache', plugins: [react(), {
  name: 'w5-calculator',
  configureServer(instance) { instance.middlewares.use(async (req, res, next) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) { res.statusCode = 503; res.end('Isolated interception required'); return; }
    if (path !== '/w5-calculator') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end(await instance.transformIndexHtml(path, '<html><body><div id="root"></div><script type="module" src="/w5-calculator.tsx"></script></body></html>'));
  }); },
  resolveId(id) { if (id === '/w5-calculator.tsx' || id === entry) return entry; },
  load(id) { if (id === entry) return `import {createElement as h,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';
import {confirmWorkbenchLeave} from '/src/components/interactionNavigation';
import '/src/styles.css';
function Host({user}){const [page,setPage]=useState('estimator');const change=async next=>{if(await confirmWorkbenchLeave())setPage(next)};return h('main',null,h('button',{onClick:()=>change('calculate')},'切换产品报价'),h(SalesWorkbench,{accessLevel:4,currentUser:user,page,onPageChange:change,view:'full',onEnter:()=>{}}))}
fetch('/api/me').then(r=>r.json()).then(user=>{const root=createRoot(document.getElementById('root'));window.w5Unmount=()=>root.unmount();root.render(h(Host,{user}));});`; },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
let browser;
const evidence = [];
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls.local[0];
  async function run(name, fault, check) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(9000);
    const errors = [], writes = [], pending = gate(), committed = gate(); let injected = false, closing = false;
    const network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') network.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) network.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const send = async (path, data, method = 'POST') => { const r = await context.request.fetch(new URL(path, api).href, { method, data }); assert.equal(r.status(), 200); return r.json(); };
    const get = async path => { const r = await context.request.get(new URL(path, api).href); assert.equal(r.status(), 200); return r.json(); };
    assert.equal((await get('/api/health')).environment, 'test');
    await send('/api/login', { username: 'test-admin', password: process.env.W5_TEST_PASSWORD });
    const before = new Set((await get(base + '/saved')).saved.map(row => row.id));
    await page.route('**/*', async route => {
      try {
        const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, new URL(origin).origin);
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.ok(url.pathname === '/api/me' || url.pathname.startsWith('/api/workbenches/sales/'));
        const saving = url.pathname === base + '/saved' && req.method() === 'POST';
        if (fault === 'committed-save' && url.pathname === base + '/saved' && req.method() === 'GET') await committed.promise;
        if (saving) {
          writes.push(req.postDataJSON());
          if (fault === 'save-slow' && !injected) { injected = true; await pending.promise; }
          if (fault === 'save-failed' && !injected) { injected = true; return route.fulfill({ status: 500, json: { detail: 'W5 合成保存失败' } }); }
        }
        const response = await route.fetch({ url: new URL(url.pathname + url.search, api).href });
        if (fault === 'committed-save' && saving && !injected) { injected = true; assert.equal(response.status(), 200); committed.release(); await pending.promise; }
        if (fault === 'history-slow' && url.pathname === base + '/saved' && req.method() === 'GET' && !injected) { injected = true; await pending.promise; }
        return route.fulfill({ response });
      } catch (error) { if (!closing) errors.push(error.message); }
    });
    try {
      await page.goto(origin + 'w5-calculator'); await page.getByRole('region', { name: '测算工具' }).waitFor();
      await check({ page, pending, get, send, writes });
      const created = (await get(base + '/saved')).saved.filter(row => !before.has(row.id));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `.scratch/w5-20261003/browser/${name}.png`, fullPage: true });
      evidence.push({ name, status: 'passed', ids: created.map(row => row.id), writes: writes.length });
    } catch (error) {
      await page.screenshot({ path: `.scratch/w5-20261003/browser/${name}-failed.png`, fullPage: true });
      writeFileSync(`.scratch/w5-20261003/browser/${name}-failed.txt`, await page.locator('body').innerText());
      writeFileSync(`.scratch/w5-20261003/browser/${name}-failed-diagnostics.json`, JSON.stringify({ errors, network }, null, 2));
      throw error;
    } finally { closing = true; pending.release(); committed.release(); await context.close(); }
  }
  await run('save-slow-keeps-newer-input-and-busy-exit', 'save-slow', async ({ page, pending, get, writes }) => {
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    const cost = page.getByRole('textbox', { name: '手工产品成本' }); await cost.fill('4');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    await cost.fill('9');
    await page.getByRole('button', { name: '切换产品报价', exact: true }).click();
    assert.equal(await cost.inputValue(), '9'); assert.equal(writes.length, 1);
    pending.release(); await page.getByRole('button', { name: '保存对比', exact: true }).waitFor();
    assert.equal(await cost.inputValue(), '9');
    await page.getByText('修改尚未保存；再次保存会新增历史记录。', { exact: false }).waitFor();
    const saved = (await get(base + '/saved')).saved[0]; assert.equal(saved.payload.source.cost, '4');
    await page.getByRole('button', { name: '切换产品报价', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click(); assert.equal(await cost.inputValue(), '9');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    assert.equal((await get(base + '/saved')).saved[0].payload.source.cost, '9');
    await cost.fill('8');
    await page.getByText('修改尚未保存；再次保存会新增历史记录。', { exact: false }).waitFor();
    await cost.fill('9');
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '切换产品报价', exact: true }).click();
    await page.getByRole('region', { name: '测算工具' }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(writes.length, 2);
    assert.equal((await get(base + '/saved')).saved.filter(row => row.payload.source?.kind === 'manual').length, 2);
  });
  await run('history-read-cannot-erase-successful-save', 'history-slow', async ({ page, pending, get }) => {
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    await page.getByRole('textbox', { name: '手工产品成本' }).fill('7');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    const saved = (await get(base + '/saved')).saved[0]; pending.release();
    await page.locator('summary').filter({ hasText: '历史测算' }).click();
    await page.getByText('正在读取历史测算', { exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('button').filter({ hasText: '手工成本 · 2 个面板' }).first().waitFor();
    assert.equal(await page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '历史测算' }) }).locator('button').filter({ hasText: '手工成本 · 2 个面板' }).count(), (await get(base + '/saved')).saved.filter(row => row.kind === 'workspace' && row.payload.source.kind === 'manual').length);
    assert.ok(saved.id);
  });
  await run('history-sees-committed-save-without-duplicate', 'committed-save', async ({ page, pending, get }) => {
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    await page.getByRole('textbox', { name: '手工产品成本' }).fill('8');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: '历史测算' }).click();
    await page.getByText('正在读取历史测算', { exact: true }).waitFor({ state: 'detached' });
    pending.release(); await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    const history = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '历史测算' }) });
    assert.equal(await history.getByRole('button').filter({ hasText: '手工成本 · 2 个面板' }).count(), (await get(base + '/saved')).saved.filter(row => row.kind === 'workspace' && row.payload.source.kind === 'manual').length);
  });
  await run('failed-save-keeps-workspace-and-template-panel-editing', 'save-failed', async ({ page, get }) => {
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    const cost = page.getByRole('textbox', { name: '手工产品成本' }); await cost.fill('4');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'W5 合成保存失败' }).waitFor(); assert.equal(await cost.inputValue(), '4');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '编辑面板 1名称', exact: true }).click();
    await page.getByRole('textbox', { name: '面板 1名称', exact: true }).fill('W5 基准');
    await page.getByRole('textbox', { name: '面板 1名称', exact: true }).press('Enter');
    await page.getByRole('button', { name: '复制面板 1', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '测算工具' }).getByRole('article').count(), 3);
    await page.getByRole('button', { name: '后移面板 1', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '测算工具' }).getByRole('article').nth(1).getByText('W5 基准', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '删除面板 1', exact: true }).click();
    await page.getByRole('button', { name: '新增对比面板', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '测算工具' }).getByRole('article').count(), 3);
    const first = page.getByRole('region', { name: '测算工具' }).getByRole('article').first();
    const stepName = first.getByRole('textbox', { name: '面板 1第 1 步名称' });
    await stepName.fill('公摊保留');
    await first.getByRole('button', { name: '拖动面板 1第 1 步排序', exact: true }).press('ArrowDown');
    assert.equal(await first.getByRole('textbox', { name: '面板 1第 2 步名称' }).inputValue(), '公摊保留');
    const from = await first.getByRole('button', { name: '拖动面板 1第 2 步排序', exact: true }).boundingBox();
    const to = await first.getByRole('button', { name: '拖动面板 1第 1 步排序', exact: true }).boundingBox(); assert.ok(from && to);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 }); await page.mouse.up();
    assert.equal(await first.getByRole('textbox', { name: '面板 1第 1 步名称' }).inputValue(), '公摊保留');
    await first.getByRole('button', { name: '拖动面板 1第 1 步排序', exact: true }).press('ArrowDown');
    await first.getByRole('button', { name: '保存公式模板', exact: true }).click();
    await first.getByRole('textbox', { name: '公式模板名称', exact: true }).fill('W5 可复用');
    await first.getByRole('button', { name: '保存模板', exact: true }).click();
    await first.getByRole('textbox', { name: '公式模板名称', exact: true }).waitFor({ state: 'detached' });
    const template = (await get(base + '/saved')).saved.find(row => row.name === 'W5 可复用'); assert.ok(template);
    await first.getByRole('button', { name: '恢复现行公式', exact: true }).click();
    await first.locator('summary[aria-label="面板 1载入公式模板"]').click();
    await page.getByRole('button', { name: 'W5 可复用', exact: true }).click();
    assert.equal(await first.getByRole('textbox', { name: '面板 1第 2 步名称' }).inputValue(), '公摊保留');
    await first.locator('summary[aria-label="面板 1载入公式模板"]').click();
    await page.getByRole('button', { name: '删除“W5 可复用”', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.equal((await get(base + '/saved')).saved.some(row => row.id === template.id), false);
  });
  await run('unapplied-tier-draft-cancel-and-reset', '', async ({ page }) => {
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    await page.getByRole('textbox', { name: '手工产品成本' }).fill('4');
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    const first = page.getByRole('region', { name: '测算工具' }).getByRole('article').first();
    await first.locator('summary').filter({ hasText: '0.50' }).click();
    await first.getByRole('button', { name: '编辑分档', exact: true }).click();
    const upper = first.getByRole('textbox', { name: '第 1 档成本上限', exact: true }); await upper.fill('6.1');
    await page.getByRole('button', { name: '切换产品报价', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click(); assert.equal(await upper.inputValue(), '6.1');
    await first.getByRole('button', { name: '恢复现行公式', exact: true }).click();
    await upper.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    await first.locator('summary[aria-label^="面板 1公摊当前分档"]').click();
    await first.getByRole('button', { name: '编辑分档', exact: true }).click(); await upper.fill('6.2');
    await first.getByRole('button', { name: '应用分档', exact: true }).click();
    await page.getByRole('button', { name: '保存对比', exact: true }).click();
    await page.getByText('已保存到历史测算。', { exact: false }).waitFor();
    await first.locator('summary[aria-label^="面板 1公摊当前分档"]').click();
    await first.getByRole('button', { name: '编辑分档', exact: true }).click(); await upper.fill('6.3');
    await page.locator('summary').filter({ hasText: '历史测算' }).click();
    await page.getByRole('button', { name: '重置测算', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click(); assert.equal(await upper.inputValue(), '6.3');
    await page.getByRole('button', { name: '重置测算', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click();
    await upper.waitFor({ state: 'detached' }); assert.equal(await page.getByRole('region', { name: '测算工具' }).getByRole('article').count(), 2);
  });
  await run('template-name-cancel-leave-and-clean-open', '', async ({ page }) => {
    const first = page.getByRole('region', { name: '测算工具' }).getByRole('article').first();
    await first.getByRole('button', { name: '保存公式模板', exact: true }).click();
    const name = first.getByRole('textbox', { name: '公式模板名称', exact: true }); await name.fill('W5 未保存名称');
    await page.getByRole('button', { name: '切换产品报价', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click(); assert.equal(await name.inputValue(), 'W5 未保存名称');
    await page.locator('summary').filter({ hasText: '历史测算' }).click();
    await page.getByRole('button').filter({ hasText: 'Q · 最新优先 · 1 个面板' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改', exact: true }).click();
    await name.waitFor({ state: 'detached' }); await page.getByText('4.00 元/kg', { exact: true }).waitFor();
  });
  await run('frozen-product-history-refresh-is-explicit', '', async ({ page, get }) => {
    await page.locator('summary').filter({ hasText: '历史测算' }).click();
    await page.getByRole('button').filter({ hasText: 'Q · 最新优先 · 1 个面板' }).click();
    await page.getByText('正式成本已变化', { exact: false }).waitFor();
    await page.getByRole('region', { name: '测算工具' }).getByRole('article').first().getByText('4.00 元/kg', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '刷新正式成本', exact: true }).click();
    await page.getByRole('region', { name: '测算工具' }).getByRole('article').first().getByText('12.00 元/kg', { exact: true }).first().waitFor();
    assert.equal((await get(base + '/saved')).saved.find(row => row.id === process.env.W5_SNAPSHOT_ID).payload.source.cost, '4');
  });
  await run('real-forward-reverse-missing-and-special-allocation', '', async ({ page }) => {
    await page.getByRole('button', { name: '手工成本', exact: true }).click();
    await page.getByRole('textbox', { name: '手工产品成本' }).fill('4');
    const first = page.getByRole('region', { name: '测算工具' }).getByRole('article').first();
    await first.getByText('6.92 元/kg', { exact: true }).waitFor();
    await first.locator('summary[aria-label="面板 1公摊模式"]').click(); await page.getByRole('button', { name: '固定数值', exact: true }).click();
    assert.equal(await first.getByRole('textbox', { name: '面板 1公摊数值', exact: true }).inputValue(), '0.50');
    await first.locator('summary[aria-label="面板 1公摊模式"]').click(); await page.getByRole('button', { name: '自动分档', exact: true }).click();
    await first.getByRole('button', { name: '反推测算', exact: true }).click();
    await first.getByRole('textbox', { name: '面板 1意向报价', exact: true }).fill('0');
    await first.getByText('该意向报价下没有非负的可用产品成本', { exact: true }).waitFor();
    await first.getByRole('textbox', { name: '面板 1意向报价', exact: true }).fill('6.92');
    await first.getByText('4.00 元/kg', { exact: true }).first().waitFor();
    const profit = first.getByRole('textbox', { name: '面板 1利润系数数值', exact: true }); await profit.fill('0');
    await first.getByText('公式结果未随产品成本递增，无法反推成本上限', { exact: true }).waitFor();
    await profit.fill('1.1');
    const freight = first.getByRole('textbox', { name: '面板 1运费数值', exact: true }); await freight.fill('');
    await first.getByText('请完成第 2 个计算系数', { exact: true }).waitFor();
    await freight.fill('0');
    await first.locator('summary[aria-label="面板 1运费算法"]').click(); await page.getByRole('button', { name: '÷', exact: true }).click();
    await first.getByText('运费的除数不能为零', { exact: true }).waitFor();
    await first.getByRole('button', { name: '常规测算', exact: true }).click();
    await first.getByRole('button', { name: '恢复现行公式', exact: true }).click();
    await first.locator('summary[aria-label="面板 1客户类型"]').click(); await page.getByRole('button', { name: '外贸直接厂', exact: true }).click();
    await first.getByText('7.36 元/kg', { exact: true }).waitFor();
    await first.locator('summary[aria-label="面板 1客户类型"]').click(); await page.getByRole('button', { name: '国内直接厂', exact: true }).click();
    await page.getByRole('button', { name: '选择产品', exact: true }).click();
    await page.locator('summary[aria-label="选择产品及成本口径"]').click();
    await page.getByRole('button', { name: /^CF401B 最新优先/ }).click();
    const allocation = first.getByRole('textbox', { name: '面板 1特殊公摊数值', exact: true }); await allocation.fill('0.2');
    await first.getByText('特殊公摊须在0.3至1元之间', { exact: true }).waitFor();
    await allocation.fill('0.3'); await first.getByText('12.05 元/kg', { exact: true }).waitFor();
  });
} finally { if (browser) await browser.close(); await server.close(); }
process.stdout.write(JSON.stringify(evidence));
