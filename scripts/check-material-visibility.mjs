import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {expect} from 'playwright/test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const output=process.argv[2]??mkdtempSync(path.join(tmpdir(),'material-visibility-'));
mkdirSync(output,{recursive:true});
const unused='(此品号不用）二次氨水';
const materials=[unused,'CF032(已停）','CF290D（已停）','CF001','CF002'].map((code,index)=>({
 id:String(index),code,name:code,unit:'kg',published_price:index===4?null:'10',latest_price:'10',inventory_price:'8',
 inventory_quantity:'10',previous_latest_price:'9',participants:[],round_participants:[],source_purchasers:[],in_formula_scope:true,
}));
const formula={id:'recipe:B-28F',name:'B-28F',owner:'合成研发人员',department:'研发二部',kind:'recipe',revision:1,yield:'1.025',ratio_linked:false,
 lines:[{kind:'material',ref:unused,code:unused,quantity:'3',ratio:'2.5',source_row:17344},{kind:'material',ref:'CF001',code:'CF001',quantity:'20',ratio:'16.7',source_row:17345}]};
const calculation={cost:null,yield:'1.025',total_input:'23',output_quantity:'23.575',missing_materials:[unused],
 lines:formula.lines.map(line=>({...line,unit_cost:line.ref===unused?null:'10',amount:line.ref===unused?null:'200',basis:line.ref===unused?'missing':'latest'}))};
const history={...formula,event_id:'frozen',recorded_at:'2026-10-13T00:00:00Z',effective_date:'2026-10-13',reason:'合成历史记录',latest_cost:null,inventory_cost:null,
 formula,latest:calculation,inventory:calculation,change:{percent:null},record_type:'formal'};
const detail={product:{...formula,lifecycle:'active',status:'missing',lines:2,has_draft:false},latest:calculation,inventory:calculation,recipes:[formula],
 draft:null,draft_revision:0,history:[history],capabilities:{can_activate:false},options:{owners:['合成研发人员'],materials:materials.map(m=>({code:m.code})),recipes:[],composites:[]}};
const batches=['2026-10-13','2026-09-01'].map((date,index)=>({id:'v'+index,version:2-index,status:index?'history':'active',price_date:date,published_at:date+'T00:00:00Z',item_count:materials.length,
 comparison:{items:{},up:0,down:0,unchanged:0,first:0,missing:0},items:materials.map(m=>({material_id:m.id,code:m.code,name:m.name,unit:'kg',latest_price:index?'9':'10'}))}));
const overview={materials,batches,metrics:{material_count:5,open_issue_count:0,missing_price_count:1,published_batch_count:2},capabilities:{can_edit:false,can_manage_catalog:true},
 current_update:null,scheduled_update:null,issues:[],updates:[],editors:[],departments:[{id:'rd2',name:'研发二部',material_ids:['0','3'],priced:2}],working_state:{status:'ready'}};
const entry=process.cwd().replaceAll('\\','/')+'/material-visibility-check.tsx';
const source=`import {createElement as h} from 'react';import {createRoot} from 'react-dom/client';
import {ProcurementWorkbench} from '/src/workbenches/ProcurementWorkbench';import {ResearchMaterialPrices} from '/src/workbenches/ResearchMaterialPrices';
import {ResearchFormulaEditor} from '/src/workbenches/ResearchFormulaEditor';import {ResearchProductDrawer} from '/src/workbenches/ResearchProductDrawer';import '/src/styles.css';
const args=new URLSearchParams(location.search),kind=args.get('kind'),detail=${JSON.stringify(detail)};const no=()=>{};
createRoot(document.getElementById('root')).render(kind==='prices'?h(ResearchMaterialPrices,{userId:'isolated'}):kind==='editor'?h(ResearchFormulaEditor,{detail,formula:detail.recipes[0],adjustment:{adjustment_reason:'成本核对修正'},accessLevel:3,onBusy:no,onBack:no,onChanged:no,onDirty:no}):kind==='detail'?h(ResearchProductDrawer,{id:'recipe:B-28F',accessLevel:2,onClose:no,onChanged:no}):h(ProcurementWorkbench,{userId:'isolated',accessLevel:2,view:args.get('view')||'full',page:args.get('page')||'materials',onPageChange:no,onEnter:no}));`;
const server=await createServer({configFile:false,cacheDir:output+'/vite',logLevel:'silent',plugins:[react(),{
 name:'material-visibility-check',resolveId(id){if(id==='/material-visibility-check.tsx'||id===entry)return entry;},load(id){if(id===entry)return source;},
 configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url.startsWith('/api/')){res.statusCode=503;return res.end('Isolated fixture required');}if(req.url.split('?')[0]!=='/material-visibility-check')return next();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await s.transformIndexHtml(req.url,'<html><head><title>隔离不用原料展示验证</title></head><body><div id="root"></div><script type="module" src="/material-visibility-check.tsx"></script></body></html>'));});}
}],server:{host:'127.0.0.1',port:0,hmr:false}});
let browser;
const receipts=[];
try{
 await server.listen();browser=await chromium.launch({headless:true});const origin=server.resolvedUrls.local[0];
 async function run(name,query,check){
  const context=await browser.newContext({viewport:{width:1440,height:1080}}),page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[],requests=[],trials=[];let denied=false;
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('403'))errors.push(message.text());});
  await page.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),p=url.pathname;requests.push(request.method()+' '+p);
   if(denied)return route.fulfill({status:403,json:{detail:'已撤销访问权限'}});
   let payload;
   if(p.endsWith('/simulate')){assert.equal(request.method(),'POST');const body=request.postDataJSON();trials.push(body);payload={current_latest:calculation,current_inventory:calculation,latest:calculation,inventory:calculation,affected:[{id:formula.id,name:formula.name}],simulation_token:'fixture-only',blocking:['原配方仍缺价'],warnings:[]};}
   else {
    assert.equal(request.method(),'GET');
    if(p.endsWith('/overview'))payload=overview;
    else if(p.endsWith('/price-series'))payload={batches};
    else if(p.endsWith('/preferences'))payload={ledger_columns:['unit','latest_price','inventory_price','status'],ledger_view:'paged',ledger_page_size:50,history_view:'batches'};
    else if(p.endsWith('/material-prices'))payload={materials,batch:{version:26},batches:[],ledger_comparison:null};
    else if(p.includes('/research/products/'))payload=detail;
    else if(p.includes('/procurement/materials/'))payload={material:materials.find(m=>m.id===p.split('/').at(-1)),official_history:batches.map(b=>({version_date:b.price_date,latest_price:'10'})),history:[],imports:[]};
    else if(p.includes('/batches/'))payload=batches.find(b=>b.id===p.split('/').at(-1));
    else if(p.endsWith('/news'))payload={items:[],sources:[],page:1,total:0};
    else throw Error('Unexpected isolated request '+p);
   }
   await route.fulfill({json:payload});
  });
  try{await page.goto(origin+'material-visibility-check?'+query);await check(page,{trials,deny:()=>{denied=true;}});assert.equal(await page.title(),'隔离不用原料展示验证');assert.deepEqual(errors,[]);receipts.push({name,passed:true,requests});console.log('PASS',name);}
  catch(error){writeFileSync(path.join(output,'failure.json'),JSON.stringify({name,errors,requests,body:await page.locator('body').innerText()},null,2));throw error;}
  finally{await context.close();}
 }
 await run('procurement-daily-and-distribution','page=materials',async(page)=>{
  await expect(page.getByRole('cell',{name:'CF001',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'CF002',exact:true})).toBeVisible();
  for(const m of materials.slice(0,3))await expect(page.getByText(m.code,{exact:true})).toHaveCount(0);
  await expect(page.getByText('2 / 2 条',{exact:true})).toBeVisible();await page.getByPlaceholder('搜索原料编号').fill('不用');await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.goto(origin+'material-visibility-check?page=distribution');await page.getByRole('button',{name:'查看明细',exact:true}).click();await expect(page.getByRole('cell',{name:'CF001',exact:true})).toBeVisible();await expect(page.getByText(unused,{exact:true})).toHaveCount(0);
  await page.screenshot({path:output+'/procurement-distribution.png'});
 });
 await run('procurement-trend-and-ranking','view=preview',async page=>{
  const menu=page.getByLabel('选择趋势原料',{exact:true});await expect(menu).toContainText('CF001');await menu.click();await expect(page.locator('button[data-material-option]')).toHaveText(['CF001','CF002']);await page.locator('button[data-material-option]').filter({hasText:'CF001'}).click();
  await expect(page.getByText(unused,{exact:true})).toHaveCount(0);await expect(page.getByText('CF032(已停）',{exact:true})).toHaveCount(0);
 });
 await run('research-daily-scopes-search-and-revocation','kind=prices',async(page,state)=>{
  await expect(page.getByRole('cell',{name:'CF001',exact:true})).toBeVisible();await expect(page.getByText(unused,{exact:true})).toHaveCount(0);
  await page.getByLabel('原料范围',{exact:true}).click();await page.getByRole('button',{name:'所有原料（2项）',exact:true}).click();
  await expect(page.getByRole('cell',{name:'CF002',exact:true})).toBeVisible();await page.getByLabel('搜索原料编号',{exact:true}).fill('不用');await expect(page.getByText(unused,{exact:true})).toHaveCount(0);await page.getByLabel('搜索原料编号',{exact:true}).fill('');
  await page.screenshot({path:output+'/research-materials.png'});state.deny();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByRole('cell',{name:'CF001',exact:true})).toHaveCount(0);
 });
 await run('existing-input-retained-new-options-filtered-and-trial-unchanged','kind=editor',async(page,state)=>{
  await expect(page.getByLabel('第1项数量',{exact:true})).toHaveValue('3');await page.locator('tr[data-input-row="0"] summary').click();
  await expect(page.locator('details[open]').getByRole('button',{name:unused,exact:true})).toHaveCount(0);await expect(page.locator('details[open]').getByRole('button',{name:'CF001',exact:true})).toBeVisible();await page.locator('tr[data-input-row="0"] summary').click();
  await page.getByRole('button',{name:'试算双成本',exact:true}).click();await expect.poll(()=>state.trials.length).toBe(1);assert.deepEqual(state.trials[0].formula.lines.map(({ref,quantity,source_row})=>({ref,quantity,source_row})),formula.lines.map(({ref,quantity,source_row})=>({ref,quantity,source_row})));
  await expect(page.getByText('原配方仍缺价',{exact:true})).toBeVisible();await page.getByRole('button',{name:'取消试算',exact:true}).click();await page.getByRole('button',{name:'添加投料',exact:true}).click();await expect(page.getByLabel('第1项数量',{exact:true})).toHaveValue('3');
  await expect(page.locator('tr[data-input-row="2"]')).toContainText('CF001');await page.screenshot({path:output+'/existing-formula-retained.png'});
 });
 await run('existing-detail-and-frozen-history-retained-readonly','kind=detail',async page=>{
  await expect(page.getByRole('button',{name:'编辑配方',exact:true})).toHaveCount(0);await expect(page.getByText('合成历史记录',{exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:unused,exact:true})).toBeVisible();await page.getByRole('button',{name:/合成历史记录/}).click();await expect(page.getByRole('button',{name:'收起本期明细',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:unused,exact:true})).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/frozen-history-mobile.png'});
 });
 writeFileSync(output+'/result.json',JSON.stringify({passed:true,browser:'Browser plugin not available; repository Playwright',origin,receipts},null,2));console.log('Evidence:',output);
}finally{await browser?.close();await server.close();}
