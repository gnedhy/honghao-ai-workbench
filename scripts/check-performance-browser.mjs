import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { loadPolicy, validatePolicy, summarize, enforceMetrics } from './performance-budget.mjs';

const policy = loadPolicy(), { workbenches } = JSON.parse(readFileSync('scripts/workbench-contracts.json', 'utf8'));
validatePolicy(policy, workbenches);
const directory = path.resolve('.scratch/performance-budget'), source = path.join(directory, 'browser-source'), output = path.join(directory, 'browser-dist');
assert.ok(path.relative(process.cwd(), output).startsWith('.scratch' + path.sep), 'Generated build must stay inside workspace scratch');
mkdirSync(source, { recursive: true });
writeFileSync(path.join(source, 'index.html'), '<!doctype html><html><head><title>Workbench performance fixture</title></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
writeFileSync(path.join(source, 'entry.tsx'), `import {createElement as h,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProcurementMaterials} from '../../../src/workbenches/ProcurementMaterials';
import {ResearchWorkbench} from '../../../src/workbenches/ResearchWorkbench';
import {SalesProductPicker} from '../../../src/workbenches/SalesProductPicker';
import '../../../src/styles.css';
const fixture=${JSON.stringify(policy.fixture)};
const code=i=>'P'+String(i).padStart(5,'0');
const materials=Array.from({length:fixture.procurementRows},(_,i)=>({id:'material-'+i,code:code(i),name:'合成原料 '+code(i),unit:'kg',latest_price:'4',published_price:'4',inventory_price:'12',inventory_quantity:'100',price_date:'2026-10-01',updated_at:'2026-10-01T00:00:00Z'}));
const products=Array.from({length:fixture.salesProducts},(_,i)=>({id:'research:recipe:'+i,code:code(i),name:code(i),source:'research',department:'合成研发',status:'ready',latest_cost:'4',inventory_cost:'12',special_allocation:false,source_version:'fixed-1'}));
const data={materials,issues:[],batches:[],current_update:null,scheduled_update:null,editors:[],departments:[],metrics:{material_count:materials.length,open_issue_count:0,missing_price_count:0,published_batch_count:0},working_state:{status:'ready',latest_import:null},next_action:'',capabilities:{can_edit:false,can_activate:false,can_manage_grants:false,can_cancel_round:false,can_manage_catalog:false}};
const noop=()=>{};function Picker(){const [selected,setSelected]=useState(products[0]);return h(SalesProductPicker,{products,selected,basis:'latest',cost:'4',onSelect:product=>{setSelected(product);window.perfSelected=product.code}})};
const kind=new URLSearchParams(location.search).get('kind');
createRoot(document.getElementById('root')).render(kind==='procurement'?h(ProcurementMaterials,{data,accessLevel:2,onOpenDepartmentMaterial:noop,startInEdit:false,onEditStarted:noop,onRefresh:async()=>{},onSaved:noop,onCreate:noop,onImport:noop,onPublish:noop,onPageChange:noop,focusPending:false,locateCode:''}):kind==='research'?h(ResearchWorkbench,{accessLevel:2,userId:'performance-fixture',view:'full',page:'products',onPageChange:noop,onEnter:noop}):h(Picker));`);

let server, browser;
const metrics = {}, samples = {};
try {
  await build({ configFile: false, root: source, plugins: [react()], logLevel: 'error', build: { outDir: output, emptyOutDir: true } });
  server = await preview({ configFile: false, root: source, build: { outDir: output }, preview: { host: '127.0.0.1', port: 0, proxy: {} }, plugins: [{ name: 'reject-unmocked-api', configurePreviewServer(instance) { instance.middlewares.use((req, res, next) => { if (req.url.startsWith('/api/')) { res.statusCode = 503; res.end('Synthetic interception required'); } else next(); }); } }] });
  const origin = server.resolvedUrls.local[0];
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  browser = await chromium.launch({ headless: true });
  async function scenario(name, kind, flow) {
    const ready = [], filtered = [], paged = [], requestCounts = [];
    for (let index = 0; index < policy.fixture.browserSamples; index++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      try {
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const session = await context.newCDPSession(page); await session.send('Emulation.setCPUThrottlingRate', { rate: policy.fixture.cpuSlowdown });
        const errors = [], unexpected = []; let requests = 0;
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== new URL(origin).origin) { unexpected.push('external'); return route.abort(); }
          if (!url.pathname.startsWith('/api/')) return route.continue();
          requests++;
          const reply = {
            '/api/workbenches/procurement/preferences': { ledger_columns: ['unit','latest_price','inventory_price','change','status'], history_view: 'batches', ledger_view: 'paged', ledger_page_size: 50 },
            '/api/workbenches/research/products': { products: Array.from({ length: policy.fixture.researchRows }, (_, i) => ({ id: 'recipe:'+i, name: 'P'+String(i).padStart(5,'0'), owner: '合成负责人', kind: 'recipe', yield: '1', lines: [], revision: 1, latest_cost: '4', inventory_cost: '12', status: 'ready', change: { percent: null, reason: '首次' }, has_draft: false })), pending: false },
            '/api/workbenches/research/history': { versions: [] },
            '/api/workbenches/research/formulas': { formulas: [], owners: ['合成负责人'] },
          }[url.pathname];
          if (request.method() !== 'GET' || !reply) { unexpected.push(url.pathname); return route.abort(); }
          return route.fulfill({ json: reply });
        });
        await page.goto(origin + '?kind=' + kind);
        assert.equal(await page.title(), 'Workbench performance fixture');
        assert.equal(new URL(page.url()).searchParams.get('kind'), kind);
        await flow(page, ready, filtered, paged);
        assert.equal(await page.locator('vite-error-overlay').count(), 0);
        assert.deepEqual(errors, [], name + ': console/runtime errors'); assert.deepEqual(unexpected, [], name + ': unexpected requests');
        requestCounts.push(requests);
        if (index === 0) await page.screenshot({ path: path.join(directory, `${kind}.png`), fullPage: false });
      } finally { await context.close(); }
    }
    const mount = summarize(ready, policy.fixture.browserSamples), input = summarize(filtered, policy.fixture.browserSamples);
    metrics[`browser.${kind}.readyMedianMs`] = mount.median; metrics[`browser.${kind}.readyMaxMs`] = mount.max;
    metrics[`browser.${kind}.filterMedianMs`] = input.median; metrics[`browser.${kind}.filterMaxMs`] = input.max;
    metrics[`browser.${kind}.requests`] = Math.max(...requestCounts); samples[kind] = { ready, filtered, requestCounts };
    if (policy.paginationModules.includes(kind)) {
      const paging = summarize(paged, policy.fixture.browserSamples);
      metrics[`browser.${kind}.pageMedianMs`] = paging.median; metrics[`browser.${kind}.pageMaxMs`] = paging.max;
      samples[kind].paged = paged;
    }
  }
  async function ledger(page, ready, filtered, paged, searchLabel, rows) {
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 50);
    ready.push(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))));
    assert.ok((await page.locator('tbody tr').first().innerText()).includes('P00000'));
    const next = page.getByRole('button', { name: '下一页', exact: true });
    await next.evaluate(element => { element.addEventListener('click', () => { window.perfPageStart = performance.now(); }, { capture: true, once: true }); });
    await next.click();
    await page.waitForFunction(() => document.querySelector('tbody tr')?.textContent.includes('P00050'));
    assert.equal(await page.locator('tbody tr').count(), 50);
    paged.push(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.perfPageStart))))));
    const code = 'P' + String(rows - 1).padStart(5, '0'), input = page.getByRole('textbox', { name: searchLabel, exact: true });
    await measureFilter(page, input, code, () => document.querySelectorAll('tbody tr').length === 1);
    assert.equal(await page.locator('tbody tr').count(), 1); assert.ok((await page.locator('tbody').innerText()).includes(code));
    filtered.push(await page.evaluate(() => window.perfFilterMs));
  }
  async function measureFilter(page, input, value, predicate) {
    await input.evaluate(element => { element.addEventListener('input', () => { window.perfInputStart = performance.now(); }, { capture: true, once: true }); });
    await input.fill(value); await page.waitForFunction(predicate);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { window.perfFilterMs = performance.now() - window.perfInputStart; resolve(); }))));
  }
  await scenario('procurement-large-ledger', 'procurement', async (page, ready, filtered, paged) => ledger(page, ready, filtered, paged, '搜索原料', policy.fixture.procurementRows));
  await scenario('research-large-ledger', 'research', async (page, ready, filtered, paged) => ledger(page, ready, filtered, paged, '搜索产品内编', policy.fixture.researchRows));
  await scenario('sales-large-catalog', 'sales', async (page, ready, filtered) => {
    await page.waitForFunction(() => document.querySelectorAll('[data-cost-option]').length === 4000);
    ready.push(await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))))));
    await page.locator('summary').first().click();
    const code = 'P' + String(policy.fixture.salesProducts - 1).padStart(5, '0');
    await measureFilter(page, page.getByRole('searchbox'), code, () => document.querySelectorAll('[data-cost-option]').length === 2);
    filtered.push(await page.evaluate(() => window.perfFilterMs));
    await page.getByRole('button', { name: code + ' 最新优先 4.00 元每千克', exact: true }).click();
    assert.equal(await page.evaluate(() => window.perfSelected), code);
  });
  writeFileSync(path.join(directory, 'browser.json'), JSON.stringify({ schema: 1, kind: 'browser', browser: browser.version(), fixture: policy.fixture, metrics, samples, browserPath: 'Browser plugin not available; existing Playwright Chromium harness' }, null, 2) + '\n');
  enforceMetrics(metrics, policy, 'browser.');
  console.log('PASS production-browser performance budgets ' + JSON.stringify(metrics));
} finally { await browser?.close(); await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve()); }
