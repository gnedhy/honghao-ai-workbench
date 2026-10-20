import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';

const entry=process.cwd().replaceAll('\\','/')+'/help-guide-check.tsx';
const preview=process.argv.includes('--preview');
const server=await createServer({configFile:false,cacheDir:'.scratch/help-guide-cache',plugins:[react(),{
  name:'help-guide-check',
  configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const path=req.url.split('?')[0];
    if(path.startsWith('/api/')){res.statusCode=503;res.end('Isolated help preview');return;}
    if(path!=='/help-guide')return next();
    res.setHeader('Content-Type','text/html');
    res.end(await server.transformIndexHtml(path,'<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>使用说明 · 隔离预览</title></head><body><div id="root"></div><script type="module" src="/help-guide-check.tsx"></script></body></html>'));
  });},
  resolveId(id){if(id==='/help-guide-check.tsx'||id===entry)return entry;},
  load(id){if(id===entry)return `import {createElement as h,useState} from 'react';import {createRoot} from 'react-dom/client';import {HelpDialog} from '/src/components/HelpDialog';import '/src/styles.css';
function Preview(){const [open,setOpen]=useState(false);return h('main',{style:{padding:32}},h('h1',null,'使用说明预览'),h('p',null,'隔离界面，不连接业务数据。'),h('button',{className:'primary-button',onClick:()=>setOpen(true)},'打开使用说明'),open&&h(HelpDialog,{onClose:()=>setOpen(false)}));}createRoot(document.getElementById('root')).render(h(Preview));`;}
}],server:{host:'127.0.0.1',port:0,hmr:false}});
let browser,passed=false;
async function scenario(name,check){await check();console.log("PASS "+name);}
try {
  await server.listen();
  const url=server.resolvedUrls.local[0]+'help-guide';
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'no-preference'});
  const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',req=>{if(new URL(req.url()).pathname.startsWith('/api/'))requests.push(req.url());});
  await scenario("help-guide: hierarchy, sales calculator, reading position, mobile, Escape, focus and no business requests",async()=>{
  await page.goto(url);
  const trigger=page.getByRole('button',{name:'打开使用说明',exact:true});
  await trigger.click();
  const dialog=page.getByRole('dialog',{name:'使用说明',exact:true});
  await dialog.waitFor();
  await dialog.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
  mkdirSync('.scratch/help-guide',{recursive:true});
  const content=page.locator('.help-content');
  const go=async name=>dialog.getByRole('button',{name:new RegExp('^'+name+'(?: |$)')}).click();
  const back=async()=>{await go('返回');await dialog.getByRole('button',{name:'工作台',exact:true}).waitFor({state:'visible'});await dialog.locator('.personal-profile__body').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));};
  assert.equal(await dialog.locator('.settings-group-trigger').count(),4);
  assert.equal(await dialog.getByText('测算工具',{exact:true}).count(),0);
  await page.screenshot({path:'.scratch/help-guide/home-desktop.png'});
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:width===390?844:900});
    for(const title of ['开始使用','我的账号','意见反馈']){
      await go(title);
      const toggle=dialog.getByRole('button',{name:title,exact:true});
      const panel=page.locator('#'+await toggle.getAttribute('aria-controls'));
      await panel.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      assert.equal(await panel.evaluate(el=>el.scrollHeight<=el.clientHeight+1),true,title+' no clipping');
      assert.equal(await dialog.getByRole('button',{name:'返回',exact:true}).count(),0);
      await go(title);
    }
    await go('工作台');
    assert.equal(await dialog.locator('[data-help-page]').count(),3);
    for(const [key,title] of [['procurement','采购工作台'],['research','研发工作台'],['sales','销售工作台']]){
      await go(title);
      await dialog.getByRole('heading',{name:title,exact:true}).waitFor();
      const motion=await dialog.locator('.personal-profile__body').evaluate(el=>el.getAnimations().map(a=>a.effect.getKeyframes()));
      assert.ok(motion.some(frames=>frames.some(frame=>frame.transform==='translateX(16px)')),title+' directional entrance animation');
      await dialog.locator('.personal-profile__body').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
      assert.equal(await dialog.locator('article').count(),1);
      assert.equal(await dialog.locator('.settings-group-collapse:visible').count(),0);
      assert.equal(await content.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      if(key==='sales'){
        await dialog.getByRole('link',{name:'查看测算工具说明'}).click();
        await page.locator('#help-calculator').waitFor();
        assert.equal(await content.evaluate(el=>el.scrollTop>0),true);
      }else await content.evaluate(el=>{el.scrollTop=160;});
      const saved=await content.evaluate(el=>el.scrollTop);
      await page.screenshot({path:`.scratch/help-guide/${key}-${width}.png`});
      await back();
      assert.equal(await dialog.getByRole('button',{name:'工作台',exact:true}).getAttribute('aria-expanded'),'true');
      await go(title);
      await dialog.getByRole('heading',{name:title,exact:true}).waitFor();
      assert.ok(Math.abs(await content.evaluate(el=>el.scrollTop)-saved)<2,title+' restores reading position');
      await back();
    }
    assert.equal(await dialog.getByRole('button',{name:'工作台',exact:true}).getAttribute('aria-expanded'),'true');
    await go('工作台');
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  assert.deepEqual(requests,[]);
  assert.deepEqual(errors,[]);
  });
  passed=true;
  if(preview)console.log('PREVIEW '+url);
} finally {
  await browser?.close();
  if(!preview||!passed)await server.close();
}
