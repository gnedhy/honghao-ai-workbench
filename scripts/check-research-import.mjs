import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';

const output='.scratch/research-import-qa';mkdirSync(output,{recursive:true});
const entry=process.cwd().replaceAll('\\','/')+'/research-import-qa.tsx';
const server=await createServer({configFile:false,logLevel:'silent',cacheDir:output+'/vite-cache',plugins:[react(),{
 name:'isolated-research-import',configureServer(instance){instance.middlewares.use(async(req,res,next)=>{
  if(req.url.startsWith('/api/')){res.statusCode=503;res.end('Isolated interception required');return;}
  if(req.url!=='/research-import-qa')return next();res.setHeader('Content-Type','text/html');res.end(await instance.transformIndexHtml(req.url,'<html><head><title>研发导入候选检查</title></head><body><div id="root"></div><script type="module" src="/research-import-qa.tsx"></script></body></html>'));
 });},resolveId(id){if(id==='/research-import-qa.tsx'||id===entry)return entry;},load(id){if(id===entry)return `import {createElement as h,useState} from 'react';import {createRoot} from 'react-dom/client';import {ResearchWorkbench} from '/src/workbenches/ResearchWorkbench';import {FormulaDetails} from '/src/workbenches/ResearchProductView';import '/src/styles.css';function Host(){const [page,setPage]=useState('products');const [policy,setPolicy]=useState('latest');return h('main',null,h('button',{onClick:()=>setPage('formulas')},'查看配方管理'),h('button',{onClick:()=>setPage('mean')},'均价引用检查'),page==='mean'?h(FormulaDetails,{formula:${JSON.stringify(meanFormula)},latest:${JSON.stringify(meanResults.latest)},inventory:${JSON.stringify(meanResults.inventory)},policy,onPolicyChange:setPolicy,onRef:()=>{}}):h(ResearchWorkbench,{accessLevel:2,userId:'synthetic-import-qa',view:'full',page,onPageChange:setPage,onEnter:()=>{}}))}createRoot(document.getElementById('root')).render(h(Host));`;}
}],server:{host:'127.0.0.1',port:0,hmr:false}});
const departments=['研发一部','研发二部','研发三部','研发四部','研发五部','研发六组','浙江实验室'];
const products=Array.from({length:2380},(_,i)=>({id:'recipe:'+i,name:'SYN-'+String(i).padStart(4,'0'),owner:'合成负责人',department:departments[i%7],source_kind:'erp_bom',yield:'1',lines:[],revision:1,has_draft:false,status:'ready',lifecycle:'active',latest_cost:'4',inventory_cost:'3',change:{percent:null,reason:'首次'},recorded_at:'2026-10-06T00:00:00Z',missing_materials:[]}));
delete products[4].department; // Existing legacy formula: backend scope remains 研发五部.
const referenceCodes=['REF-A','REF-B','REF-MISSING'];
const meanFormula={id:'synthetic-mean',name:'SYN-MEAN',kind:'recipe',source_kind:'erp_bom',yield:'1',yield_source:{kind:'user_confirmed',count:2},lines:[{kind:'material',ref:'ORIGINAL',code:'ORIGINAL',quantity:'1',ratio:'100',source_row:1,price_refs:referenceCodes}]};
const meanResults=Object.fromEntries([['latest','12',['10','14',null]],['inventory','7',['6','8',null]]].map(([policy,cost,values])=>[policy,{cost,total_input:'1',output_quantity:'1',yield:'1',missing_materials:[],lines:[{...meanFormula.lines[0],unit_cost:cost,amount:cost,basis:'reference_mean',price_reference_values:referenceCodes.map((code,i)=>({code,unit_cost:values[i],basis:values[i]===null?'missing':policy}))}]}]));
const meanMaterials=referenceCodes.map(code=>({id:code,code,name:code,unit:'kg'}));
const meanMaterialDetails=Object.fromEntries(referenceCodes.map((code,i)=>[code,{material:meanMaterials[i],official_history:[],sources:[],adjustments:[],changes:[]}]));
let browser;const evidence=[];
async function run(id,check){await check();evidence.push({id,status:'passed'});}
try{
 await server.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
 await page.route('**/api/**',route=>{
  const request=route.request();assert.equal(request.method(),'GET');const url=new URL(request.url());
  const data={'/api/workbenches/research/overview':{products,pending:false,versions:[],formulas:products,owners:['合成负责人']},'/api/workbenches/research/material-prices':{materials:meanMaterials,batches:[]},...Object.fromEntries(referenceCodes.map(code=>['/api/workbenches/research/material-prices/'+code,meanMaterialDetails[code]]))}[url.pathname];
  assert.ok(data,'Unexpected isolated request: '+url.pathname);return route.fulfill({json:data});
 });
 await page.goto(server.resolvedUrls.local[0]+'research-import-qa');
 await run('research-import-department-filter-large-catalog',async()=>{
  await page.locator('summary').filter({hasText:/^全部部门$/}).waitFor();assert.equal(await page.locator('tbody tr').count(),50);
  await page.locator('summary').filter({hasText:/^全部部门$/}).click();await page.getByRole('button',{name:'研发一部',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('tbody tr')].every(r=>r.textContent.includes('研发一部')));
  assert.equal(await page.locator('tbody tr').count(),50);assert.ok((await page.locator('body').innerText()).includes('340 / 2380'));
  await page.screenshot({path:output+'/departments.png'});
 });
 await run('research-import-legacy-department-filter',async()=>{
  await page.locator('summary').filter({hasText:/^研发一部$/}).click();await page.getByRole('button',{name:'研发五部',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索产品内编',exact:true}).fill('SYN-0004');
  await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===1&&document.querySelector('tbody tr').textContent.includes('SYN-0004'));
  const department=page.locator('tbody tr td').nth(1);assert.equal(await department.innerText(),'研发五部');
  assert.equal(await department.locator('span').getAttribute('title'),'原部门未记录，沿用研发五部数据范围。');
 });
 await run('research-import-formula-department-filter',async()=>{
  await page.getByRole('button',{name:'查看配方管理',exact:true}).click();await page.locator('summary').filter({hasText:/^全部部门$/}).click();await page.getByRole('button',{name:'研发五部',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===340&&document.querySelector('tbody').textContent.includes('SYN-0004'));
  await page.locator('summary').filter({hasText:/^研发五部$/}).click();await page.getByRole('button',{name:'浙江实验室',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('tbody tr').length===340&&[...document.querySelectorAll('tbody tr')].every(r=>r.textContent.includes('浙江实验室')));
  await page.screenshot({path:output+'/formulas.png'});await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/mobile.png'});
 });
 await run('research-import-reference-mean-drilldown',async()=>{
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'均价引用检查',exact:true}).click();
  const basis='参考原料有价算术平均 · REF-A／REF-B／REF-MISSING（2/3有价）';
  const hint=page.getByLabel(basis,{exact:true});await hint.waitFor();
  assert.equal(await hint.innerText(),'参考均价');assert.equal(await hint.getAttribute('title'),basis);assert.equal(await hint.locator('svg').count(),1);
  await page.getByText(/收率依据：业务确认指定/).waitFor();
  await page.getByRole('button',{name:'ORIGINAL',exact:true}).click();
  await page.getByRole('heading',{name:'REF-A',exact:true}).waitFor();
  await page.locator('summary').filter({hasText:'查看参考料：REF-A'}).click();await page.getByRole('button',{name:/^REF-B ·/}).click();
  await page.getByRole('heading',{name:'REF-B',exact:true}).waitFor();
  assert.ok((await page.getByRole('dialog',{name:'REF-B',exact:true}).innerText()).includes('2/3有价'));
  await page.screenshot({path:output+'/mean-reference.png'});
  await page.getByRole('button',{name:'返回配方与成本',exact:true}).click();await page.getByRole('dialog',{name:'REF-B',exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'库存优先',exact:true}).click();
  assert.ok((await page.locator('tbody tr').innerText()).includes('7.00'));
 });
 assert.deepEqual(errors,[]);writeFileSync(output+'/result.json',JSON.stringify(evidence));console.log(JSON.stringify(evidence));
}finally{await browser?.close();await server.close();}
