import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

const output='.scratch/price-cards-20261019';mkdirSync(output,{recursive:true});
const product={id:'research:card',code:'CARD-01',name:'合成卡片验收',source:'research',department:'研发一部',status:'ready',latest_cost:'15.571234',inventory_cost:'23.609876',special_allocation:false,source_version:'fixed'};
const entry=process.cwd().replaceAll('\\','/')+'/price-cards-qa.tsx';
const source=`import {createElement as h} from 'react';import {createRoot} from 'react-dom/client';import {SalesWorkbench} from '/src/workbenches/SalesWorkbench';import {PriceCards} from '/src/components/PriceCards';import {HistoryBrowser} from '/src/components/HistoryBrowser';import {HelpHint} from '/src/components/HelpHint';import {TrendMaterialMenu} from '/src/components/WorkbenchMenus';import p from '/src/components/WorkbenchSurface.module.css';import sales from '/src/workbenches/SalesWorkbench.module.css';import '/src/styles.css';const single=new URLSearchParams(location.search).has('single');createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('layout')?h('main',null,...[p.priceHistory,sales.root,sales.dialog].map((context,i)=>h('section',{className:context,'data-context':i,style:{width:460,margin:20}},h('div',{className:p.toolbar},h('label',{className:p.searchField},h('input',{'aria-label':'列表搜索'}))),h(TrendMaterialMenu,{materials:[{id:'one',code:'CF005'}],selected:'CF005',onSelect:()=>{}}),h(HistoryBrowser,{items:[{date:'2026-10-01'},{date:'2026-10-19'}],date:r=>r.date,text:r=>r.date,empty:'无记录',children:rows=>h('p',null,rows.length+'条')})))):new URLSearchParams(location.search).has('history')?h('main',null,h(HistoryBrowser,{items:Array.from({length:25},(_,i)=>({id:i,date:'2026-10-'+String(25-i).padStart(2,'0')})),date:r=>r.date,text:r=>r.date+' v'+r.id,empty:'没有记录',children:rows=>h('ul',null,rows.map(r=>h('li',{key:r.id},r.date)))}),h(HelpHint,{label:'参考均价',detail:'REF-A 与 REF-B 有价算术平均'})):single?h(PriceCards,{label:'单价',items:[{key:'zero',label:'零价',amount:'0.00',unit:'元/kg'}]}):h(SalesWorkbench,{accessLevel:2,currentUser:{id:'viewer',scope_levels:{sales:2}},page:'calculate',view:'full',onPageChange:()=>{},onEnter:()=>{}}));`;
const server=await createServer({configFile:false,logLevel:'silent',cacheDir:output+'/vite',plugins:[react(),{name:'price-cards-qa',resolveId(id){if(id==='/price-cards-qa.tsx'||id===entry)return entry;},load(id){if(id===entry)return source;},configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url.startsWith('/api/')){res.statusCode=503;return res.end();}if(req.url.split('?')[0]!=='/price-cards-qa')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,'<html><body><div id="root"></div><script type="module" src="/price-cards-qa.tsx"></script></body></html>'));});}}],server:{host:'127.0.0.1',port:0,hmr:false}});
let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));let missing=false;
 await page.route('**/api/**',route=>{assert.equal(route.request().method(),'GET','view switches must not write');const path=new URL(route.request().url()).pathname;const payload=path.endsWith('/products')?{products:[{...product,...(missing?{latest_cost:null,inventory_cost:'0'}:{})}]}:path.endsWith('/batches')?{batches:[]}:path.endsWith('/history')?{trials:[]}:path.endsWith('/records')?{records:[]}:null;assert.ok(payload,path);return route.fulfill({json:payload});});
 const origin=server.resolvedUrls.local[0];await page.goto(origin+'price-cards-qa');await page.getByRole('textbox',{name:'搜索产品',exact:true}).fill('NO-MATCH');await page.getByText('没有符合条件的产品。',{exact:true}).waitFor();await page.getByRole('button',{name:'清除筛选',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'搜索产品',exact:true}).inputValue(),'');assert.ok((await page.getByLabel('当前筛选').innerText()).includes('研发产品'));await page.getByRole('button',{name:'CARD-01',exact:true}).click();
 const drawer=page.getByRole('dialog',{name:'CARD-01',exact:true}),latest=drawer.getByRole('tab',{name:/最新优先/}),inventory=drawer.getByRole('tab',{name:/库存优先/});
 await latest.waitFor();assert.equal(await latest.getAttribute('aria-selected'),'true');assert.ok((await latest.innerText()).includes('15.57'));assert.equal(await latest.locator('[title]').getAttribute('title'),'15.571234');
 assert.equal(await drawer.getByRole('button',{name:'开始报价',exact:true}).count(),0);
 const references=drawer.getByRole('group',{name:'报价参考金额'});assert.ok((await references.innerText()).includes('20.67'));
 await latest.focus();await latest.press('ArrowRight');assert.equal(await inventory.getAttribute('aria-selected'),'true');assert.ok((await references.innerText()).includes('29.91'));assert.equal(await inventory.evaluate(e=>e===document.activeElement),true);
 await drawer.getByRole('button',{name:'价格对比',exact:true}).click();await drawer.getByText('价差',{exact:false}).first().waitFor();
 await latest.click();assert.equal(await drawer.getByText('价差',{exact:false}).count(),0);assert.ok((await references.innerText()).includes('20.67'));
 for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
  await page.setViewportSize({width,height});await page.emulateMedia({reducedMotion:'reduce'});await inventory.click();
  assert.ok(await drawer.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  assert.ok(await inventory.evaluate(e=>getComputedStyle(e).transitionDuration.split(',').every(t=>parseFloat(t)<=0.00001)));
  await page.screenshot({path:output+'/'+name+'.png'});
 }
 missing=true;await page.reload();await page.getByRole('button',{name:'CARD-01',exact:true}).click();await latest.waitFor();assert.ok((await latest.innerText()).includes('—'));assert.ok((await inventory.innerText()).includes('0.00'));await inventory.click();assert.ok(!(await references.innerText()).includes('—'));
 await page.goto(origin+'price-cards-qa?single');assert.equal(await page.getByRole('tab').count(),0);assert.ok((await page.getByRole('group',{name:'单价'}).innerText()).includes('0.00'));
 await page.goto(origin+'price-cards-qa?history');await page.locator('li').first().waitFor();assert.equal(await page.locator('li').count(),10);
 await page.getByRole('button',{name:'查看更多记录'}).click();assert.equal(await page.locator('li').count(),20);
 await page.getByLabel('历史日期范围',{exact:true}).click();assert.equal(await page.getByLabel('开始日期',{exact:true}).count(),0);await page.getByRole('button',{name:'自定义范围',exact:true}).click();await page.getByLabel('开始日期',{exact:true}).fill('2026-10-23');await page.getByRole('button',{name:'应用',exact:true}).click();assert.equal(await page.locator('li').count(),3);
 await page.getByLabel('查找记录',{exact:true}).fill('NO-MATCH');await page.getByText('当前条件下没有历史记录，请调整或清除筛选。').waitFor();
 await page.getByRole('button',{name:'清除历史筛选'}).click();assert.equal(await page.locator('li').count(),10);
 const help=page.getByLabel('REF-A 与 REF-B 有价算术平均',{exact:true});const before=await help.boundingBox();await help.hover();await help.click();assert.equal(await help.getAttribute('title'),'REF-A 与 REF-B 有价算术平均');assert.deepEqual(await help.boundingBox(),before);assert.equal(await help.locator('summary').count(),0);await page.screenshot({path:output+'/history-help.png'});
 await page.goto(origin+'price-cards-qa?layout');
 for(const context of await page.locator('[data-context]').all()) {
   for(const input of await context.locator('input').all())assert.equal(await input.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px','search must not have an inner border');
   const date=context.getByLabel('历史日期范围',{exact:true});assert.equal(Math.round((await date.boundingBox()).height),34);
   await date.click();await context.getByRole('button',{name:'自定义范围',exact:true}).click();
   assert.equal(await context.getByLabel('开始日期',{exact:true}).evaluate(el=>getComputedStyle(el).borderTopWidth),'1px','date field keeps its border');
   await date.press('Escape');
   await context.getByLabel('选择趋势原料',{exact:true}).click();
   const search=context.getByLabel('搜索趋势原料',{exact:true});assert.equal(await search.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');assert.ok((await search.boundingBox()).height<32);
   await search.fill('CF005');assert.equal(await context.getByRole('button',{name:'CF005',exact:true}).count(),1);await search.press('Escape');
 }
 await page.screenshot({path:output+'/menu-layout-contexts.png',fullPage:true});
 assert.deepEqual(errors,[]);writeFileSync(output+'/result.json',JSON.stringify({sales_linkage:true,comparison:true,read_only:true,precision:true,keyboard:true,mobile:true,reduced_motion:true,missing_and_zero:true,single_static:true}));console.log('PASS shared price cards: sales linkage, comparison, read-only, precision, keyboard, mobile, reduced motion, missing/zero and single price');
}finally{await browser?.close();await server.close();}
