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
import {ResearchMaterialPrices} from '/src/workbenches/ResearchMaterialPrices';
import {ResearchProductDrawer} from '/src/workbenches/ResearchProductDrawer';
import {FormulaDetails} from '/src/workbenches/ResearchProductView';
import {Price,ChangePrices,ReadOnlyMaterialDrawer} from '/src/workbenches/ProcurementMaterialView';
import {ProcurementMaterialDrawer} from '/src/workbenches/ProcurementMaterialDrawer';
import {fetchProcurementMaterial} from '/src/api';
import {ProcurementNews} from '/src/workbenches/ProcurementNews';
import {ProcurementDistribution} from '/src/workbenches/ProcurementDistribution';
import {ProcurementActivationGrants} from '/src/components/ActivationGrants';
import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';
import '/src/styles.css';
const kind=new URLSearchParams(location.search).get('kind');
const props={accessLevel:2,view:'preview',page:'dashboard',userId:'test',onPageChange:()=>{},onEnter:()=>{}};
const sales={...props,view:kind==='sales-preview'?'preview':'full',page:kind==='calculator'?'estimator':kind?.startsWith('sales-')?'dashboard':'calculate',currentUser:{id:'loading-test',scope_levels:{sales:2}}};
const busyLines=[{kind:'material',ref:'CF132',code:'CF132',quantity:'10',unit_cost:'10.6',amount:'106',basis:'latest'},{kind:'recipe',ref:'recipe:nested',code:'K10-K',quantity:'10',unit_cost:'12.55',amount:'125.5',basis:'recipe'}];
const busyCost={cost:'11.57',yield:'1',total_input:'20',output_quantity:'20',missing_materials:[],lines:busyLines};
createRoot(document.getElementById('root')).render(kind==='material-edit'?h(ProcurementMaterialDrawer,{batches:[],materialId:'sample',canEdit:false,canManage:false,onClose:()=>{}}):kind==='material-read'?h(ReadOnlyMaterialDrawer,{batches:[],materialId:'sample',loadMaterial:fetchProcurementMaterial,onClose:()=>{}}):kind?.startsWith('grants-')?h(ProcurementActivationGrants,{admin:true,scope:kind.slice(7),onChanged:()=>{}}):kind==='price-display'?h('div',null,h(Price,{value:'待核价'}),h('span',null,h(Price,{value:null})),h(ChangePrices,{items:[{id:'sample',code:'PRICE',unit:'kg',before_recorded:true,before:'10.1234',after:'0',change:-1}]})):kind==='material-prices'?h(ResearchMaterialPrices,{userId:'test'}):kind==='research-busy'?h(FormulaDetails,{busy:true,formula:{id:'recipe:busy',name:'合成配方',yield:'1',lines:busyLines},latest:busyCost,inventory:busyCost,policy:'latest',onPolicyChange:()=>{},onRef:()=>{throw Error('Busy navigation must not run')}}):kind==='research-detail'?h(ResearchProductDrawer,{id:'recipe:feedback',accessLevel:2,onClose:()=>{},onChanged:()=>{}}):kind==='research-pages'?h(ResearchWorkbench,{...props,view:'full',page:'products'}):kind==='research'?h(ResearchWorkbench,props):kind==='news'?h(ProcurementNews,{cache:{current:null}}):kind==='distribution'?h(ProcurementDistribution,{revision:0,renderLedger:(_data,ledger)=>h('p',null,'部门原料：'+ledger.materialIds.join(','))}):kind?.startsWith('sales')||kind==='calculator'?h(SalesWorkbench,sales):h(ProcurementWorkbench,props));`; },
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
    const salesPaths = ['read/catalog','read/overview','read/series','read/pages/records'].map(path => 'GET /api/workbenches/sales/' + path).concat(['POST /api/workbenches/sales/read/products']);
    const expected = ['material-edit','material-read'].includes(kind) ? ['GET /api/workbenches/procurement/materials/sample'] : kind.startsWith('grants-') ? ['GET /api/workbenches/'+kind.slice(7)+'/activation-grants'] : kind.startsWith('sales') ? salesPaths : kind === 'calculator' ? [...salesPaths, 'GET /api/workbenches/sales/calculator/saved-page', 'POST /api/workbenches/sales/calculator/evaluate']
      : kind === 'research-detail' ? ['GET /api/workbenches/research/products/recipe%3Afeedback', 'GET /api/workbenches/research/products/recipe%3Anested', ...['CF004','CF132','CF014'].flatMap(code=>['GET /api/workbenches/research/material-prices/by-code/'+code,...['official-history','trend'].map(suffix=>'GET /api/workbenches/research/material-prices/material-'+code+'/'+suffix)])]
      : kind === 'material-prices' ? ['GET /api/workbenches/research/material-prices', ...['BOTH','MARKET','STOCK','NONE','INFO'].map(code=>'GET /api/workbenches/research/material-prices/'+code)]
      : kind === 'research-pages' ? ['GET /api/workbenches/research/pages/products']
      : kind === 'research' ? ['dashboard','product-options','dashboard-movers','dashboard-gaps','products/recipe%3Atest/trend'].map(path => 'GET /api/workbenches/research/' + path)
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
      if(kind==='material-prices')await page.clock.install();
      await page.goto(origin + 'loading-check?kind=' + kind); await check(page);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); console.log('PASS', name);
    } finally { await page.close(); }
  }
  for(const kind of ['material-edit','material-read']) {
    const pending=gate();
    await run('material drawer stable title and failure: '+kind,kind,async route=>{
      await pending.promise;return route.fulfill({status:503,json:{detail:'合成读取失败'}});
    },async page=>{
      await page.getByText('正在读取原料详情',{exact:true}).waitFor();
      assert.equal(await page.getByRole('heading',{name:'原料详情',exact:true}).count(),1);
      assert.equal(await page.getByText('数据加载中，请稍候…',{exact:true}).count(),0);
      await page.setViewportSize({width:390,height:844});
      pending.release();await page.getByText('原料详情暂时不可用',{exact:true}).waitFor();
      assert.equal(await page.getByText('正在读取原料详情',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'重新加载',exact:true}).count(),1);
      mkdirSync('.scratch/loading-cleanup',{recursive:true});
      await page.screenshot({path:'.scratch/loading-cleanup/'+kind+'-failure.png'});
    });
  }
  for (const scope of ['procurement','research']) {
    const pending=gate();let attempts=0;
    await run('grants failure stops loading and retry: '+scope,'grants-'+scope,async route=>{
      attempts++;
      if(attempts===1){await pending.promise;return route.fulfill({status:503,json:{detail:'授权读取失败'}});}
      return route.fulfill({json:{users:[],events:[],total:0,has_more:false}});
    },async page=>{
      await page.getByText('正在读取授权…',{exact:true}).waitFor();pending.release();
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByText('正在读取授权…',{exact:true}).count(),0);
      await page.getByRole('button',{name:'重试',exact:true}).click();
      await page.getByRole('columnheader',{name:'人员',exact:true}).waitFor();
      assert.equal(await page.getByRole('alert').count(),0);
    });
  }
  {
    let reads=0;const refresh=gate(),started=gate();
    await run('distribution retains content on switch and clears denied','distribution',async route=>{
      reads++;
      if(reads===2){started.release();await refresh.promise;return route.fulfill({status:403,json:{detail:'无部门价格权限'}});}
      return route.fulfill({json:{batches:[],departments:[{id:'rd',name:'研发一部',material_ids:['CF001'],priced:1}],capabilities:{can_manage_catalog:false}}});
    },async page=>{
      await page.getByRole('button',{name:'查看明细',exact:true}).click();await started.promise;
      await page.getByText('部门原料：CF001',{exact:true}).waitFor();
      assert.equal(await page.getByText('正在读取部门原料价格',{exact:true}).count(),0);
      assert.equal(await page.getByText('正在读取价格版本',{exact:false}).count(),0);
      refresh.release();await page.getByRole('alert').waitFor();
      assert.equal(await page.getByText('部门原料：CF001',{exact:true}).count(),0);
      assert.equal(await page.getByText('正在读取部门原料价格',{exact:true}).count(),0);
      await page.getByRole('button',{name:'重试',exact:true}).click();
      await page.getByText('部门原料：CF001',{exact:true}).waitFor();
    });
  }
  let delayedPage=gate(),slowStarted=gate(),denyPage=false;
  await run('research-server-pages-abort-stale-and-clear-denied','research-pages',async route=>{
    const query=new URL(route.request().url()).searchParams;
    const search=query.get('search'), page=Number(query.get('page'));
    if(search==='slow'){slowStarted.release();await delayedPage.promise;}
    if(denyPage)return route.fulfill({status:403,json:{detail:'没有研发权限'}});
    const id=search==='fast'?'FAST':search==='slow'?'SLOW':`PAGE-${page}`;
    return route.fulfill({headers:{ETag:`W/"${id}"`},json:{items:[{id,name:id,owner:'测试负责人',department:'研发一部',yield:'1',lines:2,status:'ready',latest_cost:'1.123456',inventory_cost:'2.234567',change:{percent:null},has_draft:false}],total:150,scope_total:150,page,page_size:50,owners:['测试负责人'],department_names:['研发一部'],departments:[],creation_owners:[],pending:false}});
  },async page=>{
    await page.getByRole('button',{name:'PAGE-1',exact:true}).waitFor();
    await page.getByRole('button',{name:'下一页',exact:true}).click();
    await page.getByRole('button',{name:'PAGE-2',exact:true}).waitFor();
    const search=page.getByRole('textbox',{name:'搜索产品内编',exact:true});
    await search.fill('slow');await slowStarted.promise;
    await page.getByText('正在读取产品…',{exact:true}).waitFor();
    assert.equal(await page.getByText('正在读取产品…',{exact:true}).count(),1,'Loading stays inside the table without a duplicate layout-shifting notice');
    await search.fill('fast');await page.getByRole('button',{name:'FAST',exact:true}).waitFor();
    delayedPage.release();
    assert.equal(await page.getByRole('button',{name:'SLOW',exact:true}).count(),0);
    denyPage=true;await search.fill('denied');await page.getByRole('alert').filter({hasText:'没有研发权限'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'FAST',exact:true}).count(),0);
  });
  {
  await run('price-display-preserves-precision-and-abnormal-text','price-display',async route=>route.abort(),async page=>{
    await page.getByText('待核价',{exact:true}).waitFor();
    assert.equal(await page.locator('[title="¥10.1234"]').innerText(),'¥10.12');
    assert.equal(await page.locator('[title="¥0"]').innerText(),'¥0.00');
    await page.getByText('—',{exact:true}).waitFor();
  });
  let materialReads=0, detailReads=0, materialVersion=1, denied=false;
  const materialRows=['BOTH','MARKET','STOCK','NONE','INFO'].map(code=>({id:code,code,unit:'kg',in_formula_scope:true,published_price:['BOTH','MARKET','INFO'].includes(code)?'10.1234':null,inventory_price:['BOTH','STOCK'].includes(code)?'0':null,inventory_quantity:code==='INFO'?'123.4567':null}));
  await run('material-price-states-and-conditional-refresh','material-prices',async(route,path)=>{
    if(path.endsWith('/material-prices')) {
      materialReads++;
      if(denied)return route.fulfill({status:403,json:{detail:'权限已撤销'}});
      const tag='"materials-'+materialVersion+'"';
      if(route.request().headers()['if-none-match']===tag)return route.fulfill({status:304,headers:{ETag:tag}});
      return route.fulfill({headers:{ETag:tag},json:{materials:materialRows,batches:[],batch:null,ledger_comparison:null}});
    }
    detailReads++;
    const row=materialRows.find(row=>path.endsWith('/'+row.code));
    return route.fulfill({json:{material:row,comparison:null,sources:[],adjustments:[],official_history:row.published_price==null?[]:Array.from({length:row.code==='BOTH'?30:1},(_,i)=>({id:'period-'+i,version:i+1,version_date:'2026-10-13',latest_price:row.published_price}))}});
  },async page=>{
    await page.getByRole('button',{name:'BOTH',exact:true}).waitFor();
    await page.getByRole('button',{name:'BOTH',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await page.clock.fastForward(500);
    const beforeSwitch=await dialog.getByRole('tablist',{name:'价格口径'}).evaluate(el=>({x:el.offsetLeft,width:el.offsetWidth}));
    await dialog.getByRole('tab',{name:/库存价格/}).click();
    const afterSwitch=await dialog.getByRole('tablist',{name:'价格口径'}).evaluate(el=>({x:el.offsetLeft,width:el.offsetWidth}));
    assert.equal(afterSwitch.x,beforeSwitch.x); assert.equal(afterSwitch.width,beforeSwitch.width);
    await dialog.getByRole('heading',{name:'库存信息'}).waitFor();
    await dialog.getByRole('heading',{name:'库存价格走势',exact:true}).waitFor();
    await dialog.getByText('仅有一期库存记录，暂无走势。',{exact:true}).waitFor();
    assert.equal(await dialog.getByRole('heading',{name:'行情价格走势',exact:true}).count(),0);
    await dialog.getByRole('tab',{name:/行情价格/}).click();
    await dialog.getByRole('heading',{name:'行情价格走势',exact:true}).waitFor();
    assert.equal(await dialog.getByRole('heading',{name:'库存价格走势',exact:true}).count(),0);
    await dialog.getByRole('tab',{name:/库存价格/}).click();
    assert.equal(await dialog.locator('[title="¥0"]').innerText(),'¥0.00');
    await page.clock.fastForward(10000); assert.equal(materialReads,1); assert.equal(detailReads,1);
    const unchanged=page.waitForResponse(r=>r.status()===304);
    await page.clock.fastForward(50000); await unchanged;
    assert.equal(detailReads,1);
    materialVersion++;
    const reloaded=page.waitForResponse(r=>r.url().endsWith('/BOTH'));
    await page.clock.fastForward(60000); await reloaded;
    assert.equal(detailReads,2);
    for(const code of ['MARKET','STOCK','NONE']) {
      await page.getByRole('button',{name:'关闭详情',exact:true}).click(); await page.clock.fastForward(300);
      await page.getByRole('button',{name:code,exact:true}).click();
      await dialog.getByRole('heading',{name:code,exact:true}).waitFor();
      await dialog.getByText(code==='MARKET'?'暂无库存价格':code==='STOCK'?'暂无行情价格':'暂无行情价格和库存价格',{exact:true}).waitFor();
      assert.equal(await dialog.getByRole('group',{name:'价格口径'}).getByRole('button').count(),0);
    }
    await page.getByRole('button',{name:'关闭详情',exact:true}).click(); await page.clock.fastForward(300);
    await page.getByRole('button',{name:'INFO',exact:true}).click();
    await dialog.getByRole('tab',{name:/库存价格.*暂无库存价/}).click();
    await dialog.getByRole('heading',{name:'库存信息'}).waitFor();
    assert.equal(await dialog.locator('[title="123.4567"]').innerText(),'123.46');
    await dialog.getByText('暂无有效库存价格记录。',{exact:true}).waitFor();
    await dialog.getByRole('tab',{name:/库存价格/}).press('ArrowLeft');
    assert.equal(await dialog.getByRole('tab',{name:/行情价格/}).getAttribute('aria-selected'),'true');
    assert.equal(await dialog.locator('[title="¥10.1234"]').first().innerText(),'¥10.12');
    denied=true;
    const revoked=page.waitForResponse(r=>r.status()===403);
    await page.clock.fastForward(60000); await revoked;
    await dialog.waitFor({state:'detached'});
    assert.equal(await page.getByRole('button',{name:'BOTH',exact:true}).count(),0);
  });
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
  const researchDashboard={products:[],pending:false,versions:[],formulas:[],owners:[],dashboard:{latest_date:'2026-10-15',metrics:{products:1,up:0,down:0,missing:0,warnings:0,failed:0,drafts:0,tasks:0,periods:2,recent:'2026-10-15'}}};
  const researchRead=(path)=>path.endsWith('/dashboard')?researchDashboard:path.endsWith('/product-options')?{items:[{id:'recipe:test',code:'测试产品'}],total:1,page:1,selected:null,default:{id:'recipe:test',code:'测试产品'}}:path.endsWith('/trend')?{versions:[]}:{items:[],total:0};
  const trendPending=gate();
  await run('research trend: pending distinct from empty', 'research', async (route,path)=>{
    if(path.endsWith('/trend'))await trendPending.promise;
    return route.fulfill({json:researchRead(path)});
  },async page=>{
    await page.locator('[role="status"]').first().waitFor();
    assert.equal(await page.getByText('当前范围没有成本记录',{exact:true}).count(),0);
    trendPending.release();await page.getByText('当前范围没有成本记录',{exact:true}).waitFor();
  });
  await run('research single-product trend excludes full formula details', 'research', async (route, path) => {
    assert.ok(['/dashboard','/product-options','/dashboard-movers','/trend'].some(suffix=>path.endsWith(suffix)), 'Chart must not load formula, editing options or full history graphs');
    if(path.endsWith('/trend')){const url=new URL(route.request().url());assert.ok(url.searchParams.get('start')&&url.searchParams.get('end'),'Trend reads are date bounded');}
    return route.fulfill({json:researchRead(path)});
  }, async page => {
    await page.getByText('当前范围没有成本记录', { exact: true }).waitFor();
    assert.equal(await page.getByText('正在读取研发成本走势', { exact: true }).count(), 0);
  });
  const sales = [gate(), gate()]; let retry = false;
  const blockedRead=gate();let readCalls=0,readRecovered=false;
  await run('research-read-timeout-retains-error-and-retries', 'research', async (route,path)=>{
    if(!path.endsWith('/dashboard'))return route.fulfill({json:researchRead(path)});
    readCalls++;
    if(!readRecovered)await blockedRead.promise;
    await route.fulfill({json:researchDashboard});
  },async page=>{
    await page.getByText('数据读取超过15秒，请重试。',{exact:true}).waitFor({timeout:22000});
    assert.equal(await page.getByText('正在读取产品成本',{exact:true}).count(),0);
    await page.waitForTimeout(10500);
    assert.equal(readCalls,1,'Automatic polling must not hide an initial read failure');
    assert.ok(await page.getByText('数据读取超过15秒，请重试。',{exact:true}).isVisible());
    readRecovered=true;blockedRead.release();
    await page.getByRole('button',{name:'重新加载',exact:true}).click();
    await page.getByRole('heading',{name:'产品成本计算',exact:true}).waitFor();
    assert.equal(await page.getByText('数据读取超过15秒，请重试。',{exact:true}).count(),0);
  });
  const empty = path => path.endsWith('/catalog')?{products:[],total:0,page:1,departments:[]}:path.endsWith('/overview')?{counts:{pending:0,partial:0,adopted:0},active:0,pending:[],recent:[],hot:[],eligible:[]}:path.includes('/pages/')?{items:[],total:0,page:1,page_size:10,version:'fixed',reset:false}:path.endsWith('/products')?{products:[]}:{records:[]};
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
    if (path.endsWith('/calculator/saved-page')) {
      await history[historyRetry ? 1 : 0].promise;
      return route.fulfill(historyRetry ? { json: { saved: [],total:0,page:1,version:'fixed' } } : { status: 500, json: { detail: '合成历史读取失败' } });
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
    const record={id:'quote-1',product_id:hotProduct.id,status:'active',mode:'domestic_direct',customer_name:'合成客户',created_at:'2026-09-30T00:00:00Z',version:1,item:{cost:'12.55',final_price:'14',result:{normal_price:'14'}}};
    const json=path.endsWith('/catalog')?{products:[hotProduct],total:1,page:1,departments:[]}:path.endsWith('/products')?{products:[hotProduct]}:path.endsWith('/overview')?{counts:{pending:0,partial:0,adopted:1},active:1,pending:[],recent:[],hot:[{product_id:hotProduct.id,batches:1,adopted:1}],eligible:[]}:path.includes('/pages/')?{items:[record],total:1,page:1,page_size:10,version:'fixed',reset:false}:{records:[record]};
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
  const changedFormula={...formula,revision:2,yield:'0.9',lines:formula.lines.map(line=>({...line,quantity:'20'}))};
  const changedLatest={...latest,cost:'12.62962962962962962962962963',yield:'0.9',total_input:'60',output_quantity:'54',lines:latest.lines.map(line=>({...line,quantity:'20',amount:String(Number(line.unit_cost)*20)}))};
  const changedInventory={...inventory,cost:'11.07407407407407407407407407',yield:'0.9',total_input:'60',output_quantity:'54',lines:inventory.lines.map(line=>({...line,quantity:'20',amount:String(Number(line.unit_cost)*20)}))};
  const changedHistory=[{...record('2026-10-15',undefined,changedLatest,changedInventory,4),formula:changedFormula,reason:'配方与收率更新',change:{percent:(12.63-12.55)/12.55*100,reason:'配方与收率更新后的合成比较'}},...feedbackHistory];
  const blockedDetail=gate();let detailRecovered=false;
  await run('research-detail-timeout-and-retry','research-detail',async route=>{
    if(!detailRecovered)await blockedDetail.promise;
    await route.fulfill({json:{product:{...formula,status:'ready',lifecycle:'active'},recipes:[formula],latest,inventory,history:feedbackHistory,draft:null,draft_revision:0,options:{owners:[],materials:[],recipes:[],composites:[]}}});
  },async page=>{
    const error=page.getByRole('alert').filter({hasText:'详情读取超过15秒，请重试。'});
    await error.waitFor({timeout:22000});
    assert.equal(await page.getByText('正在读取研发配方详情',{exact:true}).count(),0);
    detailRecovered=true;blockedDetail.release();
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.getByRole('dialog',{name:'RH-13',exact:true}).waitFor();
    assert.equal(await error.count(),0);
  });
  await run('research-history-periods-and-material-price-arrows', 'research-detail', async route => route.fulfill({json:{product:{...changedFormula,status:'ready',lifecycle:'active'},recipes:[changedFormula],latest:changedLatest,inventory:changedInventory,history:changedHistory,draft:null,draft_revision:0,options:{owners:[],materials:[],recipes:[],composites:[]}}}), async page => {
    const drawer=page.getByRole('dialog',{name:'RH-13',exact:true}); await drawer.waitFor();
    await drawer.getByText('配方与收率更新',{exact:true}).waitFor();
    for (const date of ['2026-09-30','2026-09-28','2026-09-21','2026-09-14']) await drawer.getByText(date,{exact:false}).waitFor();
    await drawer.getByText('采购正式价格更新 · 采购 v24',{exact:true}).waitFor();
    const table=drawer.locator('table').first(), row=code=>table.getByRole('row').filter({hasText:code});
    await row('CF132').getByRole('img',{name:'核算单价下降：¥10.80 → ¥10.60 元/kg',exact:true}).waitFor();
    await row('CF014').getByRole('img',{name:'核算单价上涨：¥7.80 → ¥8.00 元/kg',exact:true}).waitFor();
    assert.equal(await row('CF004').getByRole('img').count(),0);
    assert.equal(await row('CF132').getByRole('img').evaluate(e=>getComputedStyle(e).color),'rgb(24, 119, 100)');
    assert.equal(await row('CF014').getByRole('img').evaluate(e=>getComputedStyle(e).color),'rgb(180, 35, 24)');
    const plainBasis = row('CF004').getByText('行情价格',{exact:true});
    assert.equal(await plainBasis.getAttribute('title'),null);
    assert.equal(await plainBasis.locator('svg').count(),0);
    await page.waitForTimeout(220); await page.screenshot({path:'.scratch/dashboard-feedback/research-latest.png'});
    await drawer.getByRole('tab',{name:/产品成本 · 库存优先/}).click();
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
    if(path.includes('/material-prices/')) {
      if(delayMaterial) await delayMaterial.promise;
      if(failMaterial) return route.fulfill({status:503,json:{detail:'合成原料读取失败'}});
      if(omitMaterial) return route.fulfill({status:404,json:{detail:'原料不存在'}});
      const code=path.includes('/by-code/')?path.split('/').at(-1):path.split('material-').at(-1).split('/')[0];
      const items=[{id:'price-23',version:23,version_date:'2026-09-21',price_date:'2026-09-21',latest_price:'10.80',modifier:null},{id:'price-24',version:24,version_date:'2026-09-28',price_date:'2026-09-28',latest_price:'10.60',modifier:null}];
      if(path.endsWith('/official-history'))return route.fulfill({json:{items,total:2,scope_total:2,start_date:'2026-09-21',end_date:'2026-09-28',version:'fixture-v1',page:1}});
      if(path.endsWith('/trend'))return route.fulfill({json:{batches:items.map(item=>({...item,items:[{material_id:'material-'+code,code,latest_price:item.latest_price}]}))}});
      return route.fulfill({json:{history_read:{base:'/api/workbenches/research/material-prices/material-'+code,total:2,start_date:'2026-09-21',end_date:'2026-09-28',version:'fixture-v1'},material:{id:'material-'+code,code,unit:'kg',inventory_price:'8.801234',inventory_quantity:'123.456789',inventory_source:{source:'ERP 库存',catalog_source:'ERP 库存',as_of:'2026-10-07',imported_at:'2026-10-15T04:03:00Z'}},comparison:null,sources:[],adjustments:[],official_history:[{id:'price-23',version:23,version_date:'2026-09-21',price_date:'2026-09-21',latest_price:'10.80',modifier:null},{id:'price-24',version:24,version_date:'2026-09-28',price_date:'2026-09-28',latest_price:'10.60',modifier:null}]}});
    }
    return route.fulfill({json:{product:{...formula,status:'ready',lifecycle:'active'},recipes:[formula],latest,inventory,history:feedbackHistory,draft:null,draft_revision:0,options:{owners:[],materials:[],recipes:[],composites:[]}}});
  }, async page => {
    const consoleFailures=[]; page.on('console',message=>{if(['error','warning'].includes(message.type())&&!/^Failed to load resource: the server responded with a status of (?:404|5\d\d)/.test(message.text()))consoleFailures.push(message.text());});
    assert.ok(new URL(page.url()).pathname==='/loading-check');
    assert.ok(await page.locator('body').innerText());
    assert.equal(await page.locator('vite-error-overlay').count(),0);
    const singleDrawer=async name=>assert.deepEqual(await page.locator('dialog[open]').evaluateAll(dialogs=>dialogs.filter(d=>getComputedStyle(d).visibility==='visible').map(d=>d.getAttribute('aria-label'))),[name],'Only the active drawer is visible');
    const parent=page.getByRole('dialog',{name:'RH-13',exact:true}); await parent.waitFor(); await singleDrawer('RH-13');
    await parent.getByRole('tab',{name:/产品成本 · 库存优先/}).click();
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
    await child.getByRole('heading',{name:'行情价格走势',exact:true}).waitFor();
    await child.getByText('2 期价格记录',{exact:true}).waitFor();
    await child.getByRole('tab',{name:/库存价格/}).click();
    await child.getByRole('heading',{name:'库存信息',exact:true}).waitFor();
    assert.equal(await child.locator('[title="¥8.801234"]').innerText(),'¥8.80');
    assert.equal(await child.locator('[title="123.456789"]').innerText(),'123.46');
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
    assert.equal(await parent.getByRole('tab',{name:/产品成本 · 库存优先/}).first().getAttribute('aria-selected'),'true');
    assert.equal(await expanded.getByRole('tab',{name:/产品成本 · 库存优先/}).getAttribute('aria-selected'),'true');
    assert.equal(await link.evaluate(e=>e===document.activeElement),true);
    assert.ok(Math.abs(await parent.locator(':scope > [class*="drawerBody"]').evaluate(e=>e.scrollTop)-scroll)<2);
    await link.click(); await child.getByText('2 期价格记录',{exact:true}).waitFor();
    await page.keyboard.press('Escape'); await child.waitFor({state:'detached'});
    await singleDrawer('RH-13');
    assert.equal(await parent.evaluate(e=>e.open),true);
    assert.equal(await link.evaluate(e=>e===document.activeElement),true);
    failMaterial=true;
    await link.click(); await child.getByText('原料详情暂时不可用',{exact:true}).waitFor();
    await child.getByRole('alert').getByText('合成原料读取失败',{exact:false}).waitFor(); await singleDrawer('CF132');
    failMaterial=false; await child.getByRole('button',{name:'重新加载',exact:true}).click();
    await child.getByText('2 期价格记录',{exact:true}).waitFor();
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
    await parent.getByRole('tab',{name:/产品成本 · 行情优先/}).click();
    const currentLink=parent.getByRole('button',{name:'CF132',exact:true});
    omitMaterial=true; await currentLink.click(); await child.getByRole('alert').getByText('原料不存在',{exact:true}).waitFor(); await singleDrawer('CF132');
    assert.equal(await child.getByRole('heading',{name:'行情价格走势',exact:true}).count(),0);
    omitMaterial=false; await child.getByRole('button',{name:'重新加载',exact:true}).click();
    await child.getByText('本层成本中的核算单价为 ¥10.60 元/kg（行情价格）。',{exact:false}).waitFor();
    assert.equal(await child.getByText('历史成本中的',{exact:false}).count(),0);
    await child.getByRole('button',{name:'返回配方与成本',exact:true}).click(); await child.waitFor({state:'detached'});
    await singleDrawer('RH-13');
    assert.equal(await currentLink.evaluate(e=>e===document.activeElement),true);
    assert.equal(materialReads.some(path=>path.endsWith('/material-prices')),false,'Material drilldown must not load the complete catalog');
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
