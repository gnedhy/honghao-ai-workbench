import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
// Run: node scripts/check-workbench-loading.mjs. All business requests are intercepted.
const server = await createServer({ configFile:false, plugins:[react(), {
  name:'loading-check',
  configureServer(server) { server.middlewares.use(async (req,res,next)=>{if(req.url.split('?')[0]!=='/loading-check') return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/loading-check','<html><head><title>Loading check</title></head><body><div id="root"></div><script type="module" src="/loading-check.tsx"></script></body></html>'));}); },
  resolveId(id) { if(id==='/loading-check.tsx') return process.cwd().replaceAll('\\','/')+'/loading-check.tsx'; },
  async load(id) { if(id===process.cwd().replaceAll('\\','/')+'/loading-check.tsx') return `import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {ProcurementWorkbench} from '/src/workbenches/ProcurementWorkbench';
import {ResearchWorkbench} from '/src/workbenches/ResearchWorkbench';
import {ProcurementNews} from '/src/workbenches/ProcurementNews';
import {ProcurementDistribution} from '/src/workbenches/ProcurementDistribution';
import '/src/styles.css';
const kind=new URLSearchParams(location.search).get('kind');
const props={accessLevel:2,view:'preview',page:'dashboard',userId:'test',onPageChange:()=>{},onEnter:()=>{}};
createRoot(document.getElementById('root')).render(kind==='research'?h(ResearchWorkbench,props):kind==='news'?h(ProcurementNews,{cache:{current:null}}):kind==='distribution'?h(ProcurementDistribution,{revision:0,renderLedger:()=>null}):h(ProcurementWorkbench,props));`; }
}], server:{host:'127.0.0.1',port:0} });
await server.listen();
const url=server.resolvedUrls.local[0];
const browser=await chromium.launch({headless:true});
try {
 for(const kind of ['procurement','research','news','distribution']) {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[]; page.on('pageerror',e=>(errors.push(e.message), console.error(e.message)));
  let finish;const gate=new Promise(resolve=>finish=resolve);
  await page.route('**/api/**',async route=>{await gate;await route.fulfill({status:500,json:{detail:'测试读取失败'}});});
  await page.goto(url+'loading-check?kind='+kind);
  const spinner=page.locator('[role="status"] svg'); await spinner.first().waitFor();
  const before=await spinner.first().evaluate(e=>getComputedStyle(e).transform);await page.waitForTimeout(120);
  assert.notEqual(await spinner.first().evaluate(e=>getComputedStyle(e).transform),before);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await spinner.first().evaluate(e=>getComputedStyle(e).animationName),'none');
  finish(); await spinner.first().waitFor({state:'detached'});
  assert.deepEqual(errors,[]);await page.close(); console.log('PASS loading -> failure:',kind);
 }
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>(errors.push(e.message), console.error(e.message)));
 let finish;const gate=new Promise(resolve=>finish=resolve);
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/products')) return route.fulfill({json:{products:[{id:'recipe:test',name:'测试产品',status:'ready',yield:'100',change:null,latest_cost:'1',inventory_cost:'1'}],pending:false}});
  if(path.endsWith('/history')) return route.fulfill({json:{versions:[]}});
  if(path.endsWith('/formulas')) return route.fulfill({json:{formulas:[],owners:[]}});
  await gate;return route.fulfill({json:{history:[]}});
 });
 await page.goto(url+'loading-check?kind=research');
 await page.getByText('正在读取研发成本走势',{exact:true}).waitFor();
 assert.equal(await page.getByText('当前范围没有成本记录',{exact:true}).count(),0);
 finish();await page.getByText('当前范围没有成本记录',{exact:true}).waitFor();
 assert.equal(await page.getByText('正在读取研发成本走势',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log('PASS research trend: pending distinct from empty');
 await page.close();
} finally { await browser.close();await server.close(); }
