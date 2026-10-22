import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {expect} from 'playwright/test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Mount the real consumers with read-only synthetic endpoints; never proxy a backend.
const output=process.argv[2]??mkdtempSync(path.join(tmpdir(),'trend-selection-'));
mkdirSync(output,{recursive:true});
const entry=process.cwd().replaceAll('\\','/')+'/trend-selection-check.tsx';
const source=`import {createElement as h,useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProcurementWorkbench} from '/src/workbenches/ProcurementWorkbench';import {ResearchWorkbench} from '/src/workbenches/ResearchWorkbench';import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';import '/src/styles.css';
function App(){const [view,setView]=useState('preview'),[user,setUser]=useState('one'),[revision,setRevision]=useState(0);const kind=new URLSearchParams(location.search).get('kind');const props={key:user+':'+revision,userId:user,accessLevel:2,view,page:'dashboard',onPageChange:()=>{},onEnter:()=>setView('full')};return h('main',null,h('nav',null,h('button',{onClick:()=>setView('preview')},'预览'),h('button',{onClick:()=>setView('full')},'完整'),h('button',{onClick:()=>setUser(user==='one'?'two':'one')},'切换账号'),h('button',{onClick:()=>setRevision(v=>v+1)},'重新读取')),kind==='procurement'?h(ProcurementWorkbench,props):kind==='research'?h(ResearchWorkbench,props):h(SalesWorkbench,{...props,currentUser:{id:user,scope_levels:{sales:2}}}));}createRoot(document.getElementById('root')).render(h(App));`;
const server=await createServer({configFile:false,logLevel:'silent',cacheDir:output+'/vite',plugins:[react(),{
 name:'trend-selection-qa',resolveId(id){if(id==='/trend-selection-check.tsx'||id===entry)return entry;},load(id){if(id===entry)return source;},
 configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url.startsWith('/api/')){res.statusCode=503;return res.end('Mock interception required');}if(req.url.split('?')[0]!=='/trend-selection-check')return next();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await s.transformIndexHtml(req.url,'<html><head><title>隔离走势默认选择验证</title></head><body><div id="root"></div><script type="module" src="/trend-selection-check.tsx"></script></body></html>'));});}
}],server:{host:'127.0.0.1',port:0,hmr:false}});
const ids=['A-1','A-10','A-2','Z-1'];
const row=id=>({id,name:id,code:id,kind:'recipe',department:'研发一部',owner:'测试',revision:1,has_draft:false,yield:'1',lines:1,status:'ready',latest_cost:'0',inventory_cost:'1',missing_materials:[],change:{percent:0},recorded_at:'2026-10-15T00:00:00Z',source:'research',special_allocation:false,source_version:'fixed'});
const dates={'A-1':[],'A-10':['2026-10-08','2026-10-15'],'A-2':['2026-09-01','2026-10-15'],'Z-1':['2026-07-01','2026-07-02'],'invisible':['2026-09-01','2026-10-15']};
const versions=Object.entries(dates).flatMap(([id,days])=>days.map(date=>({id:id+date,effective_date:date,recorded_at:date+'T00:00:00Z',record_type:'formal',products:[{...row(id),record_type:'formal',effective_date:date}]})));
const batches=[...new Set(Object.values(dates).flat())].sort().reverse().map((date,i)=>({id:'batch-'+date,version:10-i,price_date:date,published_at:date+'T00:00:00Z',comparison:{up:0,down:0,unchanged:0,first:0,missing:0,items:{}},items:Object.entries(dates).filter(([,days])=>days.includes(date)).map(([id])=>({material_id:id,code:id,latest_price:'0'}))}));
let browser;
async function waitForCurves(page){
 await expect.poll(()=>page.locator('.recharts-line-curve').evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>!node.hasAttribute('stroke-dasharray')))).toBe(true);
}
try{
 await server.listen();browser=await chromium.launch({headless:true});const origin=server.resolvedUrls.local[0];const receipts=[];
 async function run(name,kind,check){
  const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();page.setDefaultTimeout(10000);
  await page.clock.setFixedTime(new Date('2026-10-20T12:00:00Z')); // Fixture periods must not drift with the runner date.
  const state={allowed:[...ids],denied:false,seriesDenied:false,reads:[],gate:null};const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('403'))errors.push(m.text());});
  await page.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),pathname=url.pathname;state.reads.push(request.method()+' '+pathname+url.search);assert.equal(request.method(),pathname==='/api/workbenches/sales/read/products'?'POST':'GET');
   // Scope can change while an already authorized request is in flight; mirror the server's denial.
   const requestedId=/^\/api\/workbenches\/research\/products\/[^/]+\/trend$/.test(pathname)?decodeURIComponent(pathname.split('/').at(-2)):pathname==='/api/workbenches/sales/read/series'?url.searchParams.get('product'):pathname==='/api/workbenches/procurement/price-series/scoped'?url.searchParams.get('material_id'):pathname.startsWith('/api/workbenches/procurement/materials/')?decodeURIComponent(pathname.split('/').at(-1)):null;
   if(requestedId)assert.ok(ids.includes(requestedId),'Never request an identifier outside the fixture');
   if(state.denied||requestedId&&!state.allowed.includes(requestedId)||state.seriesDenied&&pathname.includes('/price-series/'))return route.fulfill({status:403,json:{detail:'权限已撤销'}});
   const products=state.allowed.map(row);let payload;
   if(pathname==='/api/workbenches/research/dashboard')payload={products:[],formulas:[],pending:false,versions:[],owners:[],dashboard:{latest_date:'2026-10-15',metrics:{products:products.length,up:0,down:0,missing:0,warnings:0,failed:0,drafts:0,tasks:0,periods:6,recent:'2026-10-15'}}};
   else if(pathname==='/api/workbenches/research/product-options'){
    const start=url.searchParams.get('start'),end=url.searchParams.get('end');assert.ok(start&&end);
    const items=[...products].sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true}));
    payload={items,total:items.length,page:1,selected:items.find(p=>p.id===url.searchParams.get('selected'))??null,default:items.find(p=>(dates[p.id]??[]).filter(day=>day>=start&&day<=end).length>=2)??items[0]??null};
   }
   else if(/^\/api\/workbenches\/research\/products\/[^/]+\/trend$/.test(pathname)){
    const id=decodeURIComponent(pathname.split('/').at(-2)),start=url.searchParams.get('start'),end=url.searchParams.get('end');assert.ok(start&&end&&state.allowed.includes(id));payload={versions:versions.filter(v=>v.products[0].id===id&&v.effective_date>=start&&v.effective_date<=end)};
   }
   else if(pathname==='/api/workbenches/research/dashboard-movers'){assert.ok(url.searchParams.get('start')&&url.searchParams.get('end'));payload={items:[],total:0};}
   else if(pathname==='/api/workbenches/research/dashboard-gaps')payload={items:[],total:0};
   else if(pathname==='/api/workbenches/sales/read/catalog'){
    assert.ok(Number(url.searchParams.get('page_size'))<=200);payload={products:[...products].sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true})),total:products.length,page:1,departments:['研发一部']};
   }
   else if(pathname==='/api/workbenches/sales/read/products'){const ids=request.postDataJSON().ids;assert.ok(ids.length<=500);payload={products:products.filter(p=>ids.includes(p.id))};}
   else if(pathname==='/api/workbenches/sales/read/overview')payload={counts:{},active:0,pending:[],recent:[],hot:[],eligible:state.allowed.filter(id=>(dates[id]??[]).filter(day=>day>=url.searchParams.get('start')&&day<=url.searchParams.get('end')).length>=2).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).slice(0,1)};
   else if(pathname==='/api/workbenches/sales/read/series'){
    const product=url.searchParams.get('product'),start=url.searchParams.get('start'),end=url.searchParams.get('end');assert.ok(product&&start&&end);assert.ok(state.allowed.includes(product));
    payload={records:versions.filter(v=>v.products[0].id===product&&v.recorded_at.slice(0,10)>=start&&v.recorded_at.slice(0,10)<=end).map(v=>({id:v.id,product_id:v.products[0].id,mode:'domestic_direct',created_at:v.recorded_at,item:{final_price:'0',result:{normal_price:'1'}}}))};
   }
   else if(pathname==='/api/workbenches/procurement/overview'){
    const mode=url.searchParams.get('read_mode');assert.ok(['summary','options'].includes(mode),'No unbounded overview requests');
    const filters=JSON.parse(url.searchParams.get('filters')??'{}');
    const preferred=state.allowed.filter(id=>(dates[id]??[]).filter(day=>day>=filters.start&&day<=filters.end).length>=2).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))[0]??state.allowed[0]??null;
    const choices=mode==='summary'?[]:[...products].sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true})).filter(p=>!filters.search||p.code.includes(filters.search)||p.id===preferred||p.id===filters.remembered);
    payload={metrics:{material_count:products.length,open_issue_count:0},materials:choices.map(p=>({...p,unit:'kg',latest_price:'0',inventory_price:'1',previous_latest_price:'10',participants:[],round_participants:[],source_purchasers:[]})),batches,current_update:null,scheduled_update:null,capabilities:{},departments:[],updates:[],read_page:{mode,total:products.length,scope_total:products.length,page:1,page_size:50,preferred}};
   }
   else if(pathname==='/api/workbenches/procurement/dashboard-summary'){
    assert.ok(url.searchParams.get('start')&&url.searchParams.get('end'));payload=url.searchParams.get('kind')==='movers'?{up:[],down:[],up_total:0,down_total:0}:{counts:{rising:0,falling:0,unchanged:0,first:0,missing:0},surge:0,total:0};
   }
   else if(pathname==='/api/workbenches/procurement/price-series/scoped'){
    const id=url.searchParams.get('material_id');
    if(id){assert.ok(state.allowed.includes(id),'Never request an unauthorized material');if(state.gate)await state.gate;}
    else assert.equal(url.searchParams.get('boundaries'),'true','Only ranking endpoints may request multiple materials');
    assert.ok(url.searchParams.get('start')&&url.searchParams.get('end'),'Every scoped read must carry its date bounds');
    payload={batches:batches.filter(batch=>!id||(batch.price_date>=url.searchParams.get('start')&&batch.price_date<=url.searchParams.get('end'))).map(batch=>({...batch,items:batch.items.filter(item=>state.allowed.includes(item.material_id)&&(!id||item.material_id===id))})).filter(batch=>batch.items.length)};
   }
   else if(pathname.startsWith('/api/workbenches/procurement/materials/')){const id=decodeURIComponent(pathname.split('/').at(-1));assert.ok(state.allowed.includes(id),'Never request an unauthorized material');if(state.gate)await state.gate;payload={material:row(id),official_history:(dates[id]??[]).map(date=>({version_date:date,latest_price:'0'}))};}
   else if(pathname==='/api/workbenches/procurement/batches/page')payload={items:batches,total:batches.length,scope_total:batches.length,page:1,version:'fixed'};
   else if(pathname.startsWith('/api/workbenches/procurement/batches/'))payload=batches.find(b=>b.id===pathname.split('/').at(-1));
   else if(pathname==='/api/workbenches/procurement/news')payload={items:[],sources:[],page:1,total:0,updated_at:null,delayed:false};
   else throw Error('Unexpected isolated request: '+pathname);
   await route.fulfill({json:payload}).catch(error=>{if(!request.failure())throw error;});
  });
  try{await page.goto(origin+'trend-selection-check?kind='+kind);await check(page,state);assert.equal(state.reads.filter(p=>/^GET \/api\/workbenches\/research\/(overview|history|products)$/.test(p)).length,0,'Research never loads the full historical matrix');if(kind==='sales')assert.equal(state.reads.filter(p=>/^GET \/api\/workbenches\/sales\/(products|batches|history|records)$/.test(p)).length,0,'Sales never loads the full directory or history matrix');assert.deepEqual(errors,[]);receipts.push({name,passed:true,reads:state.reads});console.log('PASS',name);}catch(error){writeFileSync(path.join(output,'failure.json'),JSON.stringify({errors,reads:state.reads,body:await page.locator('body').innerText()},null,2));throw error;}finally{await context.close();}
 }
 for(const kind of ['procurement','research','sales']){
  await run(`${kind}-default-manual-scope-and-session`,kind,async(page,state)=>{
   const label=kind==='procurement'?'选择趋势原料':'选择趋势产品',menu=page.getByLabel(label,{exact:true});
   await expect(menu).toContainText('A-2');assert.equal(await page.title(),'隔离走势默认选择验证');
   if(kind==='procurement'){await page.locator('[aria-label="A-2价格趋势"]').waitFor();assert.equal(state.reads.filter(p=>p.endsWith('/price-series')).length,0);assert.equal(state.reads.filter(p=>p.includes('material_id=A-2')).length,1);}
   await waitForCurves(page);await page.screenshot({path:path.join(output,kind+'-default.png')});
   // Automatic selection follows the current range before there is a manual choice.
   const dateLabel=kind==='procurement'?'走势日期范围':kind==='research'?'成本趋势日期范围':'报价趋势日期范围';
   await page.getByLabel(dateLabel,{exact:true}).click();await page.getByRole('button',{name:'最近14天',exact:true}).click();await expect(menu).toContainText('A-10');
   await menu.click();await page.getByRole('button',{name:'A-1',exact:true}).click();await page.getByLabel(dateLabel,{exact:true}).click();await page.getByRole('button',{name:'近三个月',exact:true}).click();await expect(menu).toContainText('A-1');
   await page.getByRole('button',{name:'完整',exact:true}).click();await expect(menu).toContainText('A-1');await page.getByRole('button',{name:'预览',exact:true}).click();await expect(menu).toContainText('A-1');
   if(kind==='procurement')assert.equal(state.reads.filter(p=>p.endsWith('/price-series')).length,0,'Preview/full never request the full historical matrix');
   await page.reload();await expect(menu).toContainText('A-1');
   await page.getByRole('button',{name:'切换账号',exact:true}).click();await expect(menu).toContainText('A-2');await page.getByRole('button',{name:'切换账号',exact:true}).click();await expect(menu).toContainText('A-1');
   // Revoked/removed identifiers cannot be restored from the stored selection.
   state.allowed=state.allowed.filter(id=>id!=='A-1');await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(menu).toContainText('A-2');await menu.click();await expect(page.locator('button[data-material-option]')).toHaveText(['A-2','A-10','Z-1']);await page.getByRole('button',{name:'A-10',exact:true}).click();
   await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(menu).toContainText('A-10');await waitForCurves(page);await page.screenshot({path:path.join(output,kind+'-desktop.png')});
   await page.setViewportSize({width:390,height:844});await waitForCurves(page);await menu.click();const box=await page.locator('details[open] > div').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391);await page.screenshot({path:path.join(output,kind+'-mobile.png')});await page.getByRole('button',{name:'A-10',exact:true}).click();
   state.allowed=['A-1'];await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(menu).toContainText('A-1');await expect(page.getByText(kind==='procurement'?'暂无可比较周期':kind==='research'?'当前范围没有成本记录':'当前范围没有报价记录',{exact:true})).toBeVisible();
   state.allowed=[];await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(menu).toContainText('选择原料');
   if(kind==='procurement')await expect(page.getByText('当前没有可查看的原料',{exact:true})).toBeVisible();
   state.denied=true;await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(page.getByText(kind==='procurement'?'采购工作台暂时不可用':kind==='research'?'研发工作台暂时不可用':'销售工作台暂时不可用',{exact:true})).toBeVisible();assert.equal(await page.getByLabel(label,{exact:true}).count(),0);
  });
 }
 await run('procurement-revoked-series-clears-dashboard','procurement',async(page,state)=>{
  const menu=page.getByLabel('选择趋势原料',{exact:true});await expect(menu).toContainText('A-2');state.seriesDenied=true;await page.getByRole('button',{name:'重新读取',exact:true}).click();await expect(page.getByText('采购工作台暂时不可用',{exact:true})).toBeVisible();assert.equal(await menu.count(),0);
 });
 await run('trend-session-workbench-isolation','research',async page=>{
  await expect(page.getByLabel('选择趋势产品',{exact:true})).toContainText('A-2');await page.getByLabel('选择趋势产品',{exact:true}).click();await page.getByRole('button',{name:'A-1',exact:true}).click();
  await page.goto(origin+'trend-selection-check?kind=procurement');await expect(page.getByLabel('选择趋势原料',{exact:true})).toContainText('A-2');
  await page.goto(origin+'trend-selection-check?kind=sales');await expect(page.getByLabel('选择趋势产品',{exact:true})).toContainText('A-2');
  await page.goto(origin+'trend-selection-check?kind=research');await expect(page.getByLabel('选择趋势产品',{exact:true})).toContainText('A-1');
 });
 await run('procurement-aborted-history-cannot-replace-current-selection','procurement',async(page,state)=>{
  const menu=page.getByLabel('选择趋势原料',{exact:true});await page.locator('[aria-label="A-2价格趋势"]').waitFor();
  let release;state.gate=new Promise(resolve=>{release=resolve;});await menu.click();await page.getByRole('button',{name:'A-10',exact:true}).click();await expect.poll(()=>state.reads.filter(p=>p.includes('material_id=A-10')).length).toBe(1);
  state.gate=null;await menu.click();await page.getByRole('button',{name:'A-2',exact:true}).click();await page.locator('[aria-label="A-2价格趋势"]').waitFor();release();await expect(menu).toContainText('A-2');await expect(page.locator('[aria-label="A-2价格趋势"]')).toBeVisible();
 });
 writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,receipts},null,2));console.log('Evidence:',output);
}finally{await browser?.close();await server.close();}
