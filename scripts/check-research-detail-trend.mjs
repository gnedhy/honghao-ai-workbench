import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {expect} from 'playwright/test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const output=process.argv[2]??mkdtempSync(path.join(tmpdir(),'research-detail-trend-'));
mkdirSync(output,{recursive:true});
const formula={id:'recipe:trend',name:'合成产品',owner:'合成人员',kind:'recipe',revision:1,yield:'1',lines:[{code:'CF001',kind:'material',ref:'CF001',quantity:'1'}]};
const calc=cost=>({cost,yield:'1',total_input:'1',output_quantity:'1',missing_materials:cost==null?['CF-MISSING']:[],lines:[{...formula.lines[0],unit_cost:cost,amount:cost,basis:cost==null?'missing':'latest'}]});
const row=(event_id,effective_date,record_type,latest_cost,inventory_cost,reason,recorded_at)=>({...formula,event_id,effective_date,record_type,latest_cost,inventory_cost,reason,recorded_at,product_id:formula.id,purchase_version:26,formula,latest:calc(latest_cost),inventory:calc(inventory_cost),missing_materials:latest_cost==null?['CF-MISSING']:[],change:{percent:1},status:latest_cost==null?'missing':'ready'});
const history=[
 row('current','2026-10-13','formal','5.93','3.00','采购正式价格更新','2026-10-16T03:00:00Z'),
 row('erp','2026-10-15','formal','5.92','3.10','ERP统一导入','2026-10-15T00:00:00Z'),
 row('replay','2026-10-13','backfill','9.00','3.20','冻结配方历史回算','2026-10-19T00:00:00Z'),
 row('missing','2026-10-08','backfill',null,'3.30','缺价历史回算','2026-10-19T00:00:00Z'),
 row('zero','2026-09-01','backfill','0','0','零成本历史回算','2026-10-19T00:00:00Z'),
 row('old','2026-07-01','backfill','4.00','2.00','较早历史回算','2026-10-19T00:00:00Z'),
];
history[0].change.reason='最新优先成本（按两位小数比较）：5.59 → 5.93';
const detail={product:{...formula,lifecycle:'active',status:'ready',has_draft:false,latest_cost:'5.93',inventory_cost:'3.00',lines:1},latest:calc('5.93'),inventory:calc('3.00'),recipes:[formula],draft:null,draft_revision:0,history,capabilities:{can_activate:false},options:{owners:[],materials:[],recipes:[],composites:[]}};
const entry=process.cwd().replaceAll('\\','/')+'/research-detail-trend-check.tsx';
const source=`import {createElement as h} from 'react';import {createRoot} from 'react-dom/client';import {ResearchProductDrawer} from '/src/workbenches/ResearchProductDrawer';import '/src/styles.css';createRoot(document.getElementById('root')).render(h(ResearchProductDrawer,{id:'recipe:trend',accessLevel:3,onClose:()=>{},onChanged:()=>{}}));`;
const server=await createServer({configFile:false,logLevel:'silent',cacheDir:output+'/vite',plugins:[react(),{
 name:'research-detail-trend-check',resolveId(id){if(id==='/research-detail-trend-check.tsx'||id===entry)return entry;},load(id){if(id===entry)return source;},
 configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url.startsWith('/api/')){res.statusCode=503;return res.end('Isolated fixture required');}if(req.url!=='/research-detail-trend-check')return next();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await s.transformIndexHtml(req.url,'<html><head><title>隔离产品详情走势验证</title></head><body><div id="root"></div><script type="module" src="/research-detail-trend-check.tsx"></script></body></html>'));});}
}],server:{host:'127.0.0.1',port:0,hmr:false}});
let browser;const receipts=[];
async function settled(page){await expect.poll(()=>page.locator('dialog').first().evaluate(el=>el.getAnimations({subtree:true}).every(animation=>animation.playState!=='running'&&animation.playState!=='pending'))).toBe(true);}
try{
 await server.listen();browser=await chromium.launch({headless:true});const origin=server.resolvedUrls.local[0];
 async function run(name,rows,check,options={}){
  const context=await browser.newContext({viewport:{width:1440,height:1100},...options}),page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[],requests=[];const state={denied:false};
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('403'))errors.push(m.text());});
  await page.route('**/api/**',async route=>{const req=route.request();assert.equal(req.method(),'GET','The trend must not write or simulate');requests.push(req.url());const url=new URL(req.url()),pathname=url.pathname;let payload;
   if(state.denied)return route.fulfill({status:403,json:{detail:'已撤销访问权限'}});
   if(pathname.endsWith('/edit-options')){if(state.editGate)await state.editGate;if(state.editDenied)return route.fulfill({status:403,json:{detail:'编辑权限已撤销'}});payload={options:detail.options,options_loaded:true};}
   else if(pathname.endsWith('/history-page')){assert.equal(url.searchParams.get('page_size'),'10');const search=url.searchParams.get('search')??'';const items=rows.filter(r=>JSON.stringify(r).includes(search)).sort((a,b)=>b.effective_date.localeCompare(a.effective_date)||Number(a.record_type==='backfill')-Number(b.record_type==='backfill'));payload={items,total:items.length,scope_total:rows.length,version:'fixed',min_date:rows.map(r=>r.effective_date).sort()[0]??'',max_date:'2026-10-15'};}
   else if(pathname.includes('/history-record/'))payload={products:rows.filter(r=>r.event_id===pathname.split('/').at(-1))};
   else if(pathname.endsWith('/trend')){const start=url.searchParams.get('start'),end=url.searchParams.get('end');assert.ok(start&&end);payload={versions:rows.filter(r=>r.effective_date>=start&&r.effective_date<=end).map(r=>({id:r.event_id,products:[r]}))};}
   else {assert.ok(pathname.endsWith('/products/recipe%3Atrend'));assert.equal(url.searchParams.get('history'),'false');payload={...detail,history:[],history_total:rows.length,max_date:'2026-10-15',options_loaded:false};}
   await route.fulfill({json:payload});});
  try{await page.goto(origin+'research-detail-trend-check');await page.getByRole('heading',{name:'成本历史',exact:true}).waitFor();await check(page,state,requests);assert.equal(await page.title(),'隔离产品详情走势验证');assert.deepEqual(errors,[]);receipts.push({name,passed:true,requests});console.log('PASS',name);}
  catch(error){writeFileSync(output+'/failure.json',JSON.stringify({name,errors,requests,body:await page.locator('body').innerText()},null,2));await settled(page);await page.screenshot({path:output+'/failure.png'});throw error;}
  finally{await context.close();}
 }
 await run('revocation-cannot-be-undone-by-old-editor-read',history,async(page,state,requests)=>{
  let release;state.editGate=new Promise(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'编辑配方',exact:true}).click();await expect.poll(()=>requests.filter(url=>url.includes('/edit-options')).length).toBe(1);
  state.denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('activation-grants-changed')));await expect(page.getByRole('alert')).toContainText('已撤销访问权限');
  release();await page.waitForTimeout(300);await expect(page.getByText('记录调整原因',{exact:true})).toHaveCount(0);
  assert.equal(await page.getByRole('tab',{name:/产品成本 · 行情优先/}).count(),0,'Revoked product must not be restored by old edit-options');
 });
 await run('edit-options-lazy-load-and-denied-clear',history,async(page,state,requests)=>{
  await expect(page.getByRole('button',{name:'编辑配方',exact:true})).toBeVisible();assert.equal(requests.filter(url=>url.includes('/edit-options')).length,0);
  await page.getByRole('button',{name:'编辑配方',exact:true}).click();await expect(page.getByText('记录调整原因',{exact:true})).toBeVisible();assert.equal(requests.filter(url=>url.includes('/edit-options')).length,1);
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>requests.filter(url=>url.includes('history=false')).length).toBe(2);
  state.editDenied=true;await page.getByRole('button',{name:'编辑配方',exact:true}).click();await expect(page.getByRole('alert')).toContainText('编辑权限已撤销');await expect(page.getByRole('button',{name:'编辑配方',exact:true})).toHaveCount(0);
 });
 const trend=page=>page.getByRole('region',{name:/产品成本走势 ·/});
 const dateMenu=page=>page.getByLabel('产品详情走势日期范围',{exact:true});
 await run('detail-trend-policy-dates-tooltip-and-frozen-history',history,async(page,state,requests)=>{
  const graph=trend(page);await expect(graph.getByRole('heading')).toHaveText('产品成本走势 · 行情优先');await expect(dateMenu(page)).toContainText('近三个月');
  await expect(page.getByRole('tab',{name:/产品成本 · 行情优先/})).toContainText('5.93');
  await expect(page.locator('[title="行情优先成本（按两位小数比较）：5.59 → 5.93；变化 1%"]')).toHaveCount(1);
  const dates=await page.locator('button[aria-expanded] > span[title^="记录时间："]').allTextContents();assert.deepEqual(dates.map(text=>text.trim().slice(0,10)),['2026-10-15','2026-10-13','2026-10-13','2026-10-08','2026-09-01','2026-07-01']);
  const readCount=requests.length;const gap=graph.getByRole('img',{name:/2026-10-08.*CF-MISSING/});await gap.hover();await expect(graph.getByText(/缺价原料：CF-MISSING；曲线保留断点/)).toBeVisible();
  await page.getByRole('tab',{name:/产品成本 · 库存优先/}).click();await expect(graph.getByRole('heading')).toHaveText('产品成本走势 · 库存优先');await expect(graph.getByRole('img',{name:/CF-MISSING/})).toHaveCount(0);await expect(graph.getByText('单位：元/kg · 回算库存为固定参考',{exact:true})).toBeVisible();
  await expect(graph.locator('.recharts-line-curve').first()).toBeVisible();await settled(page);await page.screenshot({path:output+'/inventory-desktop.png'});
  await dateMenu(page).click();await page.getByRole('button',{name:'近一个月',exact:true}).click();await page.getByRole('tab',{name:/产品成本 · 行情优先/}).click();await expect(dateMenu(page)).toContainText('近一个月');
  await expect(graph.getByRole('img',{name:/CF-MISSING/})).toHaveCount(1);assert.ok(requests.length>readCount,'Date changes read only the chosen product range');assert.equal(requests.filter(url=>url.includes('/edit-options')).length,0,'Read-only detail never loads edit choices');
  await page.getByRole('searchbox',{name:'查找记录',exact:true}).fill('ERP统一导入');await expect(page.getByRole('button',{name:/ERP统一导入/})).toBeVisible();await expect(graph.getByRole('heading')).toHaveText('产品成本走势 · 行情优先');
  await page.getByRole('searchbox',{name:'查找记录',exact:true}).fill('');await settled(page);await page.screenshot({path:output+'/latest-desktop.png'});
  await page.getByRole('button',{name:/ERP统一导入/}).click();await expect(page.getByRole('button',{name:'收起本期明细',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:/产品成本 · 行情优先/}).first()).toContainText('5.93');
 });
 await run('inventory-gap-retains-fixed-reference-caption',history.map(record=>record.event_id==='missing'?{...record,inventory_cost:null}:record),async page=>{
  await page.getByRole('tab',{name:/产品成本 · 库存优先/}).click();const graph=trend(page);
  await expect(graph.getByText(/单位：元\/kg · 回算库存为固定参考/)).toBeVisible();
  await expect(graph.getByText(/缺失成本已标记，悬停可查看原因。/)).toBeVisible();
  await expect(graph.getByRole('img',{name:/2026-10-08/})).toHaveCount(1);
 });
 await run('single-effective-period-does-not-invent-trend',[history[0],history[2]],async page=>{
  await expect(trend(page).getByText('暂无走势',{exact:true})).toBeVisible();await expect(trend(page).getByText('当前范围仅有一期有效成本记录。',{exact:true})).toBeVisible();await expect(trend(page).locator('svg.recharts-surface')).toHaveCount(0);
 });
 await run('empty-history-is-not-zero-cost',[],async page=>{
  await expect(trend(page).getByText('当前范围没有有效成本记录。',{exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:/产品成本 · 行情优先/})).toContainText('5.93');
 });
 await run('revoked-detail-clears-trend-and-history',history,async(page,state)=>{
  await expect(trend(page)).toBeVisible();state.denied=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('alert')).toContainText('已撤销访问权限');await expect(trend(page)).toHaveCount(0);await expect(page.getByRole('button',{name:/ERP统一导入/})).toHaveCount(0);
 });
 await run('mobile-keyboard-range-and-reduced-motion',history,async page=>{
  await expect(trend(page)).toBeVisible();await page.getByRole('tab',{name:/产品成本 · 行情优先/}).focus();await page.keyboard.press('ArrowRight');await expect(trend(page).getByRole('heading')).toHaveText('产品成本走势 · 库存优先');
  await dateMenu(page).click();const menu=page.locator('details[open] > div');const box=await menu.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391);await settled(page);await page.screenshot({path:output+'/mobile-date-menu.png'});await page.getByRole('button',{name:'近一个月',exact:true}).click();
  await page.getByRole('tab',{name:/产品成本 · 行情优先/}).click();await settled(page);await page.screenshot({path:output+'/latest-mobile.png'});const overflow=await page.locator('dialog').evaluate(element=>element.scrollWidth>element.clientWidth+1);assert.equal(overflow,false);
 },{viewport:{width:390,height:844},reducedMotion:'reduce'});
 writeFileSync(output+'/result.json',JSON.stringify({passed:true,browser:'Browser plugin not available; installed repository Playwright',receipts},null,2));console.log('Evidence:',output);
}finally{await browser?.close();await server.close();}
