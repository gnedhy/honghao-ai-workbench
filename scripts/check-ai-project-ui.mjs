import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

const api=new URL(process.env.H05_TEST_API??'');
assert.equal(api.hostname,'127.0.0.1');
assert.ok(api.port&&!['8000','8080'].includes(api.port)&&process.env.H05_TEST_PASSWORD);
const output=process.env.H05_UI_OUTPUT??'.scratch/h05-ui';mkdirSync(output,{recursive:true});
const server=await createServer({configFile:false,logLevel:'silent',plugins:[react()],cacheDir:'.scratch/h05-ui/vite-cache',
  server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':api.origin}}});
let browser;const evidence=[];
try{
  await server.listen();browser=await chromium.launch({headless:true});const origin=server.resolvedUrls.local[0];
  async function run(name,width,check,username='alice'){
    const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.name));
    assert.equal((await context.request.post(origin+'api/login',{data:{username,password:process.env.H05_TEST_PASSWORD}})).status(),200);
    const get=async path=>{const reply=await context.request.get(origin+path);assert.equal(reply.status(),200);return reply.json();};
    const nav=async name=>{if(width<600)await page.getByRole('button',{name:'打开导航',exact:true}).click();await page.getByRole('button',{name,exact:true}).click();};
    try{
      await page.goto(origin);await page.locator('.sidebar__brand').waitFor();await nav('新聊天');
      await check({page,context,get,nav,origin});
      assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.evaluate(()=>Promise.all(document.getAnimations({subtree:true}).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
      await page.screenshot({path:`${output}/${width}-${name}.png`,fullPage:true});evidence.push({name,width,status:'passed'});
    }catch(error){await page.screenshot({path:`${output}/${width}-${name}-failed.png`,fullPage:true});throw error;}
    finally{await context.close();}
  }
  await run('h05-project-receipt-rename-and-exits',1440,async({page,get,origin})=>{
    await page.getByRole('button',{name:'新建项目',exact:true}).click();
    const name=page.getByLabel('项目名称',{exact:true});await name.fill('H05 synthetic project');
    await page.getByRole('button',{name:'关闭项目详情',exact:true}).click();
    await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await name.inputValue(),'H05 synthetic project');
    let lost=true;
    await page.route('**/api/projects',async route=>{
      if(route.request().method()==='POST'&&lost){lost=false;assert.equal((await route.fetch()).status(),201);return route.abort('connectionclosed');}
      return route.continue();
    });
    await page.getByRole('button',{name:'创建项目',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'创建结果未确认'}).waitFor();
    await name.fill('H05 later proposed name');
    await page.getByRole('button',{name:'重新确认创建结果',exact:true}).click();
    await page.getByText('当前已保存名称：H05 synthetic project',{exact:true}).waitFor();
    assert.equal((await get('api/projects')).length,1);assert.equal(await name.inputValue(),'H05 later proposed name');
    const project=(await get('api/projects'))[0];
    assert.equal((await page.request.patch(origin+`api/projects/${project.id}`,{data:{title:'H05 concurrent name',revision:project.revision}})).status(),200);
    await page.getByRole('button',{name:'保存名称',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'版本已变化'}).waitFor();assert.equal(await name.inputValue(),'H05 later proposed name');
    await page.getByText('当前已保存名称：H05 concurrent name',{exact:true}).waitFor();
    await page.getByRole('button',{name:'保存名称',exact:true}).click();
    await page.getByText('已保存',{exact:true}).waitFor();
    assert.equal((await get('api/projects'))[0].title,'H05 later proposed name');
    await page.screenshot({path:output+'/1440-project-details.png',fullPage:true});
    await page.getByRole('button',{name:'关闭项目详情',exact:true}).click();
  });
  await run('h05-chat-work-draft-and-real-history',1024,async({page,get,nav})=>{
    await page.getByRole('tab',{name:'聊天',exact:true}).click();
    let release,received;const gate=new Promise(resolve=>{release=resolve;});const captured=new Promise(resolve=>{received=resolve;});
    await page.route('**/api/conversation-submissions',async route=>{const response=await route.fetch();received();await gate;await route.fulfill({response});});
    const input=page.getByLabel('输入聊天消息',{exact:true});await input.fill('H05 chat question');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();await captured;
    await input.fill('H05 later draft while accepting');release();
    await page.locator('.chat-turn--assistant').filter({hasText:'synthetic runtime reply'}).waitFor();
    await page.locator('.conversation-state').filter({hasText:'已完成'}).waitFor();
    assert.equal(await input.inputValue(),'H05 later draft while accepting');
    assert.deepEqual(await get('api/tasks'),[]);
    await page.getByRole('tab',{name:'工作',exact:true}).click();await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    assert.equal(await input.inputValue(),'H05 later draft while accepting');
    await input.fill('');await page.getByRole('tab',{name:'工作',exact:true}).click();
    const work=page.getByLabel('输入工作要求',{exact:true});await work.fill('H05 first work');await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.locator('.conversation-state').filter({hasText:'已完成'}).waitFor();
    const first=(await get('api/tasks'))[0];assert.ok(first);
    await work.fill('H05 work continuation');await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.chat-turn--assistant').length===3);
    assert.equal((await get('api/tasks')).length,1);assert.equal((await get('api/tasks'))[0].id,first.id);
    await nav('任务看板');await page.getByRole('tab',{name:'运行记录',exact:true}).click();
    await page.locator('.ai-run-row').first().waitFor();assert.equal(await page.locator('.ai-run-row').count(),2);
    await page.locator('.ai-run-row').first().click();await page.getByRole('dialog',{name:'运行详情',exact:true}).waitFor();
    assert.ok(await page.locator('.ai-run-output').textContent().then(value=>value.includes('synthetic runtime reply')));
  });
  await run('h05-mobile-navigation-draft-preservation',390,async({page,nav,get,origin})=>{
    const input=page.getByLabel('输入工作要求',{exact:true});await input.fill('H05 mobile unsaved draft\nsecond line');
    await nav('任务看板');await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    assert.equal(await input.inputValue(),'H05 mobile unsaved draft\nsecond line');
    // Dismiss the still-open navigation, which is independent of the draft.
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'交给智能体执行',exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'添加内容',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'选择模型',exact:true}).count(),0);
    await page.route('**/api/tasks',route=>route.fulfill({status:403,json:{detail:'Synthetic task module unavailable'}}));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByText('任务模块当前不可用，请切换聊天问答。',{exact:true}).waitFor();
    assert.equal(await input.inputValue(),'H05 mobile unsaved draft\nsecond line');
    assert.equal(await page.getByRole('heading',{name:'登录工作台',exact:true}).count(),0);
    await page.unroute('**/api/tasks');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByRole('button',{name:'交给智能体执行',exact:true}).waitFor();
    let release,received,accepted;const gate=new Promise(resolve=>{release=resolve;});const captured=new Promise(resolve=>{received=resolve;});
    await page.route('**/api/conversation-submissions',async route=>{
      const response=await route.fetch();accepted=await response.json();received();await gate;await route.fulfill({response});
    });
    await input.fill('H05 delayed work acceptance');await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();await captured;
    await page.route('**/api/tasks',route=>route.fulfill({status:403,json:{detail:'Synthetic task module unavailable'}}));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('任务模块当前不可用，请切换聊天问答。',{exact:true}).waitFor();
    let starts=0;await page.route('**/api/conversations/*/messages/*/execution',route=>{if(route.request().method()==='POST')starts++;return route.continue();});
    release();await page.waitForFunction(()=>document.querySelector('.composer__submit')?.getAttribute('aria-busy')==='false');
    assert.equal(starts,0);assert.deepEqual(await get(`api/tasks/${accepted.task.id}/runs`),[]);
    assert.equal(await page.locator('.conversation-entry').count(),0);
    await input.fill('H05 mobile draft remains usable after module loss');
  });
  await run('h05-legacy-admin-readonly-consumer',1440,async({page,nav})=>{
    await nav('任务看板');await page.locator('.task-table').getByRole('button',{name:'历史合成目标',exact:true}).click();
    await page.getByText('这是无主历史会话，仅供只读查看。',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('输入工作要求',{exact:true}).getAttribute('readonly'),'');
    assert.equal(await page.getByRole('button',{name:'交给智能体执行',exact:true}).isDisabled(),true);
    await page.getByLabel('选择项目',{exact:true}).click();
    assert.equal(await page.locator('.composer').getByRole('button',{name:'不关联项目',exact:true}).isDisabled(),true);
    await page.keyboard.press('Escape');
  },'test-admin');
  await run('h05-identity-switch-never-submits-old-draft',1440,async({page,context,get,origin})=>{
    const privateDraft='身份切换前的合成私有草稿';
    await page.getByLabel('输入工作要求',{exact:true}).fill(privateDraft);
    // Another tab can change the same host-only cookie without updating this
    // mounted App's actor. No old draft may be accepted under the new actor.
    assert.equal((await context.request.post(origin+'api/login',{data:{username:'bob',password:process.env.H05_TEST_PASSWORD}})).status(),200);
    await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.composer__submit')?.getAttribute('aria-busy')==='false');
    assert.deepEqual(await get('api/conversations'),[]);
    assert.deepEqual(await get('api/tasks'),[]);
    assert.equal((await get('api/me')).username,'bob');
    await page.getByRole('button',{name:'bob 企业用户',exact:true}).waitFor();
    assert.equal(await page.getByLabel('输入工作要求',{exact:true}).inputValue(),'');
  });
  console.log(JSON.stringify(evidence));
}finally{await browser?.close();await server.close();}
