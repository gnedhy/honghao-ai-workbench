import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';

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
import {ResearchProductDrawer} from '/src/workbenches/ResearchProductDrawer';
import {FormulaDetails} from '/src/workbenches/ResearchProductView';
import {ProcurementNews} from '/src/workbenches/ProcurementNews';
import {ProcurementDistribution} from '/src/workbenches/ProcurementDistribution';
import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';
import '/src/styles.css';
const kind=new URLSearchParams(location.search).get('kind');
const props={accessLevel:2,view:'preview',page:'dashboard',userId:'test',onPageChange:()=>{},onEnter:()=>{}};
const sales={...props,view:kind==='sales-preview'?'preview':'full',page:kind==='calculator'?'estimator':kind?.startsWith('sales-')?'dashboard':'calculate',currentUser:{id:'loading-test',scope_levels:{sales:2}}};
const busyLines=[{kind:'material',ref:'CF132',code:'CF132',quantity:'10',unit_cost:'10.6',amount:'106',basis:'latest'},{kind:'recipe',ref:'recipe:nested',code:'K10-K',quantity:'10',unit_cost:'12.55',amount:'125.5',basis:'recipe'}];
const busyCost={cost:'11.57',yield:'1',total_input:'20',output_quantity:'20',missing_materials:[],lines:busyLines};
createRoot(document.getElementById('root')).render(kind==='research-busy'?h(FormulaDetails,{busy:true,formula:{id:'recipe:busy',name:'合成配方',yield:'1',lines:busyLines},latest:busyCost,inventory:busyCost,policy:'latest',onPolicyChange:()=>{},onRef:()=>{throw Error('Busy navigation must not run')}}):kind==='research-detail'?h(ResearchProductDrawer,{id:'recipe:feedback',accessLevel:2,onClose:()=>{},onChanged:()=>{}}):kind==='research'?h(ResearchWorkbench,props):kind==='news'?h(ProcurementNews,{cache:{current:null}}):kind==='distribution'?h(ProcurementDistribution,{revision:0,renderLedger:()=>null}):kind?.startsWith('sales')||kind==='calculator'?h(SalesWorkbench,sales):h(ProcurementWorkbench,props));`; },
}], server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function drawerMotion(button, leaving, returning) {
  const frames = await button.evaluate(element => new Promise(resolve => {
    const frames = [], start = performance.now();
    const sample = () => {
      frames.push([...document.querySelectorAll('dialog[open]')].filter(d => getComputedStyle(d).visibility === 'visible').map(d => ({name:d.getAttribute('aria-label'), x:new DOMMatrixReadOnly(getComputedStyle(d).transform).m41})));
      if (performance.now()-start < 500) requestAnimationFrame(sample); else resolve(frames);
    };
    element.click(); requestAnimationFrame(sample);
  }));
  assert.ok(frames.every(frame => frame.length <= 1), 'Transitions retain a single visible drawer');
  const positions = name => frames.flat().filter(frame => frame.name === name).map(frame => frame.x);
  const outgoing = positions(leaving), incoming = positions(returning);
  assert.ok(new Set(outgoing.map(Math.round)).size >= 3 && outgoing.some(x => x > 1), 'The outgoing drawer moves through intermediate frames before removal');
  assert.ok(new Set(incoming.map(Math.round)).size >= 3 && incoming.at(-1) === 0, 'The returning drawer moves through intermediate frames into its final position');
}
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const origin = server.resolvedUrls.local[0];
  async function run(name, kind, respond, check) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(7000);
    const errors = [], unexpected = []; page.on('pageerror', error => errors.push(error.message));
    const salesPaths = ['products', 'batches', 'history', 'records'].map(path => 'GET /api/workbenches/sales/' + path);
    const expected = kind.startsWith('sales') ? salesPaths : kind === 'calculator' ? [...salesPaths, 'GET /api/workbenches/sales/calculator/saved', 'POST /api/workbenches/sales/calculator/evaluate']
      : kind === 'research-detail' ? ['GET /api/workbenches/research/products/recipe%3Afeedback', 'GET /api/workbenches/research/products/recipe%3Anested', 'GET /api/workbenches/research/material-prices', ...['CF004','CF132','CF014'].map(code=>'GET /api/workbenches/research/material-prices/material-'+code)]
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
  mkdirSync('.scratch/dashboard-feedback', {recursive:true});
  const hotProduct = {id:'research:recipe:feedback',code:'K10-K',name:'合成产品',source:'research',department:'测试研发',status:'ready',latest_cost:'12.55',inventory_cost:'10.93',source_version:'fixed',special_allocation:false};
  await run('sales-hot-product-existing-drawer', 'sales-dashboard', async (route,path) => {
    const json = path.endsWith('/products') ? {products:[hotProduct]} : path.endsWith('/batches') ? {batches:[]}
      : path.endsWith('/history') ? {trials:[{batch_id:'batch-1',items:[{product_id:hotProduct.id}]}]}
      : {records:[{id:'quote-1',product_id:hotProduct.id,status:'active',mode:'domestic_direct',customer_name:'合成客户',created_at:'2026-09-30T00:00:00Z',version:1,item:{cost:'12.55',final_price:'14',result:{normal_price:'14'}}}]};
    await route.fulfill({json});
  }, async page => {
    for (const kind of ['sales-dashboard','sales-preview']) {
      if (kind==='sales-preview') await page.goto(origin+'loading-check?kind='+kind);
      const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'热门报价产品',exact:true})});
      const link=panel.getByRole('button',{name:/K10-K/}); await link.waitFor();
      assert.equal(await link.locator('svg').evaluate(e=>getComputedStyle(e).opacity),'0');
      await link.hover(); await page.waitForTimeout(200); assert.equal(await link.locator('svg').evaluate(e=>getComputedStyle(e).opacity),'1');
      await link.focus(); await page.keyboard.press('Enter');
      const drawer=page.getByRole('dialog',{name:'K10-K',exact:true}); await drawer.waitFor();
      await drawer.getByRole('heading',{name:'报价参考',exact:true}).waitFor(); await drawer.getByText('合成客户',{exact:false}).waitFor();
      await page.waitForTimeout(220); assert.ok(await drawer.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
      await page.screenshot({path:'.scratch/dashboard-feedback/'+kind+'.png'});
      await page.keyboard.press('Escape'); await drawer.waitFor({state:'detached'});
      assert.equal(await link.evaluate(e=>e===document.activeElement),true);
      await page.mouse.move(0,0); await page.keyboard.press('Tab'); await page.waitForTimeout(200);
      assert.equal(await link.locator('svg').evaluate(e=>getComputedStyle(e).opacity),'0');
    }
  });
  const line=(ref,unit_cost,basis='latest')=>({kind:'material',ref,code:ref,quantity:'10',unit_cost,amount:'100',basis});
  const calculation=(cost,lines)=>({cost,yield:'0.98',total_input:'30',output_quantity:'29.4',missing_materials:[],lines});
  const latest=calculation('12.55',[line('CF004','15.5'),line('CF132','10.6'),line('CF014','8')]);
  const inventory=calculation('10.93',[line('CF004','13.5','inventory'),line('CF132','8.8','inventory'),line('CF014','7.6','inventory')]);
  const previousLatest=calculation('12.57',[line('CF004','15.5'),line('CF132','10.8'),line('CF014','7.8')]);
  const previousInventory=calculation('12.30',[line('CF004','15.5','inventory'),line('CF132','8.8','inventory'),line('CF014','7.6','inventory')]);
  const formula={id:'recipe:feedback',name:'RH-13',kind:'recipe',owner:'合成负责人',revision:1,yield:'0.98',lines:latest.lines};
  const record=(effective_date,purchase_version,left,right,index)=>({...formula,product_id:formula.id,event_id:'event-'+index,record_type:'formal',recorded_at:'2026-09-30T02:39:3'+index+'Z',effective_date,purchase_version,reason:index===3?'库存价格更新':'采购正式价格更新',formula,latest:left,inventory:right,latest_cost:left.cost,inventory_cost:right.cost,change:{percent:-0.2,reason:'合成比较'}});
  const feedbackHistory=[record('2026-09-30',undefined,latest,inventory,3),record('2026-09-28',24,latest,previousInventory,2),record('2026-09-21',23,previousLatest,previousInventory,1),record('2026-09-14',22,previousLatest,previousInventory,0)];
  await run('research-history-periods-and-material-price-arrows', 'research-detail', async route => route.fulfill({json:{product:{...formula,status:'ready',lifecycle:'active'},recipes:[formula],latest,inventory,history:feedbackHistory,draft:null,draft_revision:0,options:{owners:[],materials:[],recipes:[],composites:[]}}}), async page => {
    const drawer=page.getByRole('dialog',{name:'RH-13',exact:true}); await drawer.waitFor();
    for (const date of ['2026-09-30','2026-09-28','2026-09-21','2026-09-14']) await drawer.getByText(date,{exact:false}).waitFor();
    await drawer.getByText('采购正式价格更新 · 采购 v24',{exact:true}).waitFor();
    const table=drawer.locator('table').first(), row=code=>table.getByRole('row').filter({hasText:code});
    await row('CF132').getByRole('img',{name:'核算单价下降：¥10.80 → ¥10.60 元/kg',exact:true}).waitFor();
    await row('CF014').getByRole('img',{name:'核算单价上涨：¥7.80 → ¥8.00 元/kg',exact:true}).waitFor();
    assert.equal(await row('CF004').getByRole('img').count(),0);
    assert.equal(await row('CF132').getByRole('img').evaluate(e=>getComputedStyle(e).color),'rgb(24, 119, 100)');
    assert.equal(await row('CF014').getByRole('img').evaluate(e=>getComputedStyle(e).color),'rgb(180, 35, 24)');
    await page.waitForTimeout(220); await page.screenshot({path:'.scratch/dashboard-feedback/research-latest.png'});
    await drawer.getByRole('button',{name:'库存优先',exact:true}).click();
    await row('CF004').getByRole('img',{name:'核算单价下降：¥15.50 → ¥13.50 元/kg',exact:true}).waitFor();
    assert.equal(await row('CF132').getByRole('img').count(),0); assert.equal(await row('CF014').getByRole('img').count(),0);
    await page.setViewportSize({width:390,height:844}); await page.emulateMedia({reducedMotion:'reduce'});
    assert.ok(await row('CF004').getByRole('img').isVisible());
    assert.ok(await drawer.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
    await row('CF004').getByRole('img').scrollIntoViewIfNeeded();
    await page.screenshot({path:'.scratch/dashboard-feedback/research-mobile.png'});
  });
  let failMaterial = false, omitMaterial = false, delayMaterial = null;
  const materialReads = [];
  await run('research-material-drilldown-return-history-and-focus', 'research-detail', async (route,path) => {
    materialReads.push(path);
    if(path.endsWith('/material-prices')) return route.fulfill({json:{batches:[],materials:(omitMaterial?[]:['CF004','CF132','CF014']).map(code=>({id:'material-'+code,code}))}});
    if(path.includes('/material-prices/')) {
      if(delayMaterial) await delayMaterial.promise;
      if(failMaterial) return route.fulfill({status:503,json:{detail:'合成原料读取失败'}});
      const code=path.split('material-').at(-1);
      return route.fulfill({json:{material:{id:'material-'+code,code},comparison:null,sources:[],adjustments:[],official_history:[{id:'price-23',version:23,version_date:'2026-09-21',price_date:'2026-09-21',latest_price:'10.80',modifier:null},{id:'price-24',version:24,version_date:'2026-09-28',price_date:'2026-09-28',latest_price:'10.60',modifier:null}]}});
    }
    return route.fulfill({json:{product:{...formula,status:'ready',lifecycle:'active'},recipes:[formula],latest,inventory,history:feedbackHistory,draft:null,draft_revision:0,options:{owners:[],materials:[],recipes:[],composites:[]}}});
  }, async page => {
    const consoleFailures=[]; page.on('console',message=>{if(['error','warning'].includes(message.type())&&!/^Failed to load resource: the server responded with a status of 5\d\d/.test(message.text()))consoleFailures.push(message.text());});
    assert.ok(new URL(page.url()).pathname==='/loading-check');
    assert.ok(await page.locator('body').innerText());
    assert.equal(await page.locator('vite-error-overlay').count(),0);
    const singleDrawer=async name=>assert.deepEqual(await page.locator('dialog[open]').evaluateAll(dialogs=>dialogs.filter(d=>getComputedStyle(d).visibility==='visible').map(d=>d.getAttribute('aria-label'))),[name],'Only the active drawer is visible');
    const parent=page.getByRole('dialog',{name:'RH-13',exact:true}); await parent.waitFor(); await singleDrawer('RH-13');
    await parent.getByRole('button',{name:'库存优先',exact:true}).click();
    const history=parent.getByRole('button').filter({hasText:'2026-09-21'});
    await history.click();
    const expanded=parent.locator('[class*="expandedRecord"]');
    const link=expanded.getByRole('button',{name:'CF132',exact:true});
    await link.scrollIntoViewIfNeeded();
    await page.mouse.move(0,0); await page.waitForTimeout(190);
    assert.equal(await link.locator('svg').evaluate(e=>getComputedStyle(e).opacity),'0');
    await link.hover(); await page.waitForTimeout(190);
    assert.equal(await link.locator('svg').evaluate(e=>getComputedStyle(e).opacity),'1');
    const scroll=await parent.locator(':scope > [class*="drawerBody"]').evaluate(e=>e.scrollTop);
    await link.focus(); await page.keyboard.press('Enter');
    const child=page.getByRole('dialog',{name:'CF132',exact:true}); await child.waitFor();
    await child.getByText('2026-09-21 历史成本中的核算单价为 ¥8.80 元/kg（库存价格）。',{exact:false}).waitFor();
    await child.getByRole('heading',{name:'有效价格走势',exact:true}).waitFor();
    await child.getByText('2 期有效价格',{exact:true}).waitFor();
    await singleDrawer('CF132');
    assert.deepEqual(await page.locator('dialog[aria-label="RH-13"]').evaluate(e=>[getComputedStyle(e).visibility,getComputedStyle(e,'::backdrop').visibility]),['hidden','hidden']);
    assert.ok(await child.evaluate(e=>e.matches(':modal')));
    assert.equal(await child.evaluate(e=>e.contains(document.activeElement)),true);
    await child.getByRole('button',{name:'关闭原料详情',exact:true}).focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await child.getByRole('button',{name:'返回配方与成本',exact:true}).evaluate(e=>e===document.activeElement),true);
    await page.waitForTimeout(1700); await page.screenshot({path:'.scratch/dashboard-feedback/material-drilldown-desktop.png'});
    await drawerMotion(child.getByRole('button',{name:'返回配方与成本',exact:true}), 'CF132', 'RH-13'); await child.waitFor({state:'detached'});
    await singleDrawer('RH-13');
    assert.equal(await history.getAttribute('aria-expanded'),'true');
    assert.equal(await parent.getByRole('button',{name:'库存优先',exact:true}).first().getAttribute('aria-pressed'),'true');
    assert.equal(await expanded.getByRole('button',{name:'库存优先',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await link.evaluate(e=>e===document.activeElement),true);
    assert.ok(Math.abs(await parent.locator(':scope > [class*="drawerBody"]').evaluate(e=>e.scrollTop)-scroll)<2);
    await link.click(); await child.getByText('2 期有效价格',{exact:true}).waitFor();
    await page.keyboard.press('Escape'); await child.waitFor({state:'detached'});
    await singleDrawer('RH-13');
    assert.equal(await parent.evaluate(e=>e.open),true);
    assert.equal(await link.evaluate(e=>e===document.activeElement),true);
    failMaterial=true;
    await link.click(); await child.getByText('原料详情暂时不可用',{exact:true}).waitFor();
    await child.getByRole('alert').getByText('合成原料读取失败',{exact:false}).waitFor(); await singleDrawer('CF132');
    failMaterial=false; await child.getByRole('button',{name:'重新加载',exact:true}).click();
    await child.getByText('2 期有效价格',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844}); await page.emulateMedia({reducedMotion:'reduce'});
    await singleDrawer('CF132');
    assert.ok(await child.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));
    assert.ok(await child.getByRole('button',{name:'返回配方与成本',exact:true}).isVisible());
    const backBounds=await child.getByRole('button',{name:'返回配方与成本',exact:true}).boundingBox(), closeBounds=await child.getByRole('button',{name:'关闭原料详情',exact:true}).boundingBox();
    assert.ok(Math.abs(backBounds.y-closeBounds.y)<4 && closeBounds.x>backBounds.x,'Mobile header keeps back and close on one row');
    await page.screenshot({path:'.scratch/dashboard-feedback/material-drilldown-mobile.png'});
    await child.getByRole('button',{name:'关闭原料详情',exact:true}).click(); await child.waitFor({state:'detached'});
    const before=materialReads.filter(path=>path.endsWith('/products/recipe%3Afeedback')).length;
    assert.equal(before,1,'Returning must not reload/reset the product drawer');
    delayMaterial=gate(); await link.click(); await child.getByText('正在读取原料详情',{exact:true}).waitFor(); await singleDrawer('CF132');
    await child.getByRole('button',{name:'返回配方与成本',exact:true}).click(); await child.waitFor({state:'detached'});
    delayMaterial.release(); delayMaterial=null;
    assert.equal(await history.getAttribute('aria-expanded'),'true');
    await history.click(); await page.setViewportSize({width:1280,height:900}); await page.emulateMedia({reducedMotion:'no-preference'});
    await parent.getByRole('button',{name:'最新优先',exact:true}).click();
    const currentLink=parent.getByRole('button',{name:'CF132',exact:true});
    omitMaterial=true; await currentLink.click(); await child.getByRole('alert').getByText('此投料未关联当前原料价格目录',{exact:true}).waitFor(); await singleDrawer('CF132');
    assert.equal(await child.getByRole('heading',{name:'有效价格走势',exact:true}).count(),0);
    omitMaterial=false; await child.getByRole('button',{name:'重新加载',exact:true}).click();
    await child.getByText('本层成本中的核算单价为 ¥10.60 元/kg（最新价格）。',{exact:false}).waitFor();
    assert.equal(await child.getByText('历史成本中的',{exact:false}).count(),0);
    await child.getByRole('button',{name:'返回配方与成本',exact:true}).click(); await child.waitFor({state:'detached'});
    await singleDrawer('RH-13');
    assert.equal(await currentLink.evaluate(e=>e===document.activeElement),true);
    assert.deepEqual(consoleFailures,[]);
  });
  const nestedFormula={...formula,id:'recipe:nested',name:'K10-K'};
  const referenceLine={...line(nestedFormula.id,'12.55'),kind:'recipe',code:nestedFormula.name,basis:'recipe'};
  const referenceFormula={...formula,lines:[referenceLine]};
  await run('research-reference-back-in-drawer-header', 'research-detail', async (route,path) => {
    const nested=path.endsWith('recipe%3Anested'), active=nested?nestedFormula:referenceFormula;
    await route.fulfill({json:{product:{...active,status:'ready',lifecycle:'active'},recipes:[active],latest:nested?latest:calculation('12.55',[referenceLine]),inventory:nested?inventory:calculation('10.93',[referenceLine]),history:[],draft:null,draft_revision:0,options:{owners:[],materials:[],recipes:[],composites:[]}}});
  },async page=>{
    const root=page.getByRole('dialog',{name:'RH-13',exact:true}); await root.getByRole('button',{name:'K10-K',exact:true}).click();
    const nested=page.getByRole('dialog',{name:'K10-K',exact:true}); await nested.getByRole('heading',{name:'投料明细 · 3 条',exact:true}).waitFor();
    const header=nested.locator(':scope > header'), back=header.getByRole('button',{name:'返回上层',exact:true});
    await back.waitFor(); assert.equal(await nested.getByRole('button',{name:'返回上层',exact:true}).count(),1);
    assert.equal(await nested.locator(':scope > [class*="drawerBody"]').getByRole('button',{name:'返回上层',exact:true}).count(),0);
    const position=async()=>assert.ok(await header.evaluate(element=>{const arrow=element.querySelector('button[aria-label="返回上层"]').getBoundingClientRect(), title=element.querySelector('h2').getBoundingClientRect();return arrow.x<title.x && Math.abs(arrow.y-title.y)<25;}));
    await position(); await page.screenshot({path:'.scratch/dashboard-feedback/reference-back-header.png'});
    await page.setViewportSize({width:390,height:844}); await position();
    await drawerMotion(back, 'K10-K', 'RH-13'); await root.getByRole('button',{name:'K10-K',exact:true}).waitFor();
    assert.equal(await root.getByRole('button',{name:'返回上层',exact:true}).count(),0);
    assert.equal(await root.evaluate(e=>e.open),true);
    await page.goto(origin+'loading-check?kind=research-busy');
    for(const name of ['CF132','K10-K']) {
      const link=page.getByRole('button',{name,exact:true}); await link.waitFor(); assert.equal(await link.isDisabled(),true);
      await link.evaluate(e=>e.click());
    }
    assert.equal(await page.getByRole('dialog').count(),0);
  });
} finally { await browser?.close(); await server.close(); }
