import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

const api=new URL(process.env.H04_TEST_API ?? '');
assert.equal(api.hostname,'127.0.0.1');
assert.ok(api.port && !['8000','8080'].includes(api.port) && process.env.H04_TEST_PASSWORD);
const output='.scratch/h04-ui';mkdirSync(output,{recursive:true});
const server=await createServer({configFile:false,logLevel:'silent',plugins:[react()],
  cacheDir:output+'/vite-cache',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':api.origin}}});
let browser;const evidence=[];
try {
  await server.listen();browser=await chromium.launch({headless:true});
  const origin=server.resolvedUrls.local[0];
  async function run(name,width,check) {
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.name));
    assert.equal((await context.request.post(origin+'api/login',{data:{username:'alice',password:process.env.H04_TEST_PASSWORD}})).status(),200);
    const get=async path=>{const response=await context.request.get(origin+path);assert.equal(response.status(),200);return response.json();};
    try {
      await page.goto(origin);await page.locator('.sidebar__brand').waitFor();
      if(width<600)await page.getByRole('button',{name:'打开导航',exact:true}).click();
      await page.getByRole('button',{name:'新聊天',exact:true}).click();
      await check({page,context,get});
      assert.deepEqual(errors,[]);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:`${output}/${width}-${name}.png`,fullPage:true});
      evidence.push({name,status:'passed',width});
    } catch(error) {await page.screenshot({path:`${output}/${width}-${name}-failed.png`,fullPage:true});throw error;}
    finally {await context.close();}
  }
  const send=async(page,text)=>{
    await page.getByLabel('输入工作要求',{exact:true}).fill(text);
    await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.locator('.conversation-entry').filter({hasText:text}).waitFor();
  };
  await run('h04-actual-app-execute-and-reconcile',1440,async({page,get})=>{
    let failConfig=true;
    await page.route('**/api/conversations/runtime-status',route=>failConfig
      ? route.fulfill({status:503,json:{detail:'Synthetic config read failure'}}) : route.continue());
    await send(page,'H04 synthetic first');
    await page.getByRole('alert').filter({hasText:'AI 执行配置读取失败'}).waitFor();
    failConfig=false;
    await page.getByRole('button',{name:'重新读取执行状态',exact:true}).click();
    await page.getByRole('button',{name:'开始执行',exact:true}).waitFor();
    await send(page,'H04 synthetic supplement');
    await page.locator('.conversation-entry').filter({hasText:'H04 synthetic first'}).getByRole('button',{name:'查看本次执行',exact:true}).click();
    let failRefresh=true;
    await page.route('**/api/tasks',route=>failRefresh && route.request().method()==='GET'
      ? route.fulfill({status:503,json:{detail:'Synthetic read failure'}}) : route.continue());
    await page.getByRole('button',{name:'开始执行',exact:true}).click();
    await page.locator('.conversation-state').filter({hasText:'已完成'}).waitFor();
    await page.getByRole('alert').filter({hasText:'正文与任务读取失败'}).waitFor();
    failRefresh=false;
    await page.getByRole('button',{name:'重新读取执行状态',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'正文与任务读取失败'}).waitFor({state:'hidden'});
    await page.locator('.chat-turn--assistant').filter({hasText:'synthetic runtime reply'}).waitFor();
    assert.equal(await page.locator('.chat-turn--assistant').filter({hasText:'synthetic runtime reply'}).count(),1);
    await page.locator('.conversation-entry').filter({hasText:'H04 synthetic supplement'}).getByRole('button',{name:'查看本次执行',exact:true}).click();
    let releaseTasks;
    const heldTasks=new Promise(resolve=>{releaseTasks=resolve;});
    let oldSnapshot;
    const captured=new Promise(resolve=>{oldSnapshot=resolve;});
    await page.route('**/api/tasks',async route=>{
      if(route.request().method()!=='GET')return route.continue();
      const response=await route.fetch();const rows=await response.json();
      if(rows.some(task=>task.status==='completed')){
        oldSnapshot(rows);await heldTasks;
      }
      await route.fulfill({response,json:rows});
    });
    await page.getByRole('button',{name:'开始执行',exact:true}).click();
    await page.locator('.conversation-state').filter({hasText:'已完成'}).waitFor();
    const oldRows=await captured;
    await send(page,'LONG H04 next accepted while old refresh pending');
    await page.getByRole('button',{name:'开始执行',exact:true}).click();
    await page.locator('.conversation-state').filter({hasText:'执行中'}).waitFor();
    releaseTasks();
    await page.waitForTimeout(300);
    await page.locator('.conversation-entry').filter({hasText:'LONG H04 next accepted while old refresh pending'}).waitFor();
    const tasks=await get('api/tasks');assert.equal(tasks.length,1);assert.equal(tasks[0].status,'running');
    assert.ok(tasks[0].revision>oldRows[0].revision);
    await page.getByRole('button',{name:'任务看板',exact:true}).click();
    await page.locator('.task-board').waitFor();
    await page.locator('.task-table .task-status').filter({hasText:'执行中'}).waitFor();
    await page.getByRole('button',{name:'H04 synthetic first',exact:true}).click();
    await page.getByRole('button',{name:'停止执行',exact:true}).click();
    await page.locator('.conversation-state').filter({hasText:'已停止'}).waitFor();
    const runs=await get(`api/tasks/${tasks[0].id}/runs`);assert.equal(runs.length,3);
    assert.deepEqual(runs.map(run=>run.status),['completed','completed','stopped']);
    assert.ok(!await page.locator('.conversation-screen').textContent().then(text=>text.includes('synthetic-thread')));
  });
  await run('h04-actual-app-disconnect-stop-and-revoke',390,async({page,context,get})=>{
    await send(page,'LONG H04 synthetic cancellation');
    let disconnected=false;
    await page.route('**/api/conversations/*/executions/*/events?*',route=>{
      if(!disconnected){disconnected=true;return route.abort('connectionclosed');}
      return route.continue();
    });
    await page.getByRole('button',{name:'开始执行',exact:true}).click();
    await page.locator('.chat-turn--assistant').filter({hasText:'synthetic'}).waitFor();
    const tasks=await get('api/tasks');const current=tasks.find(task=>task.objective==='LONG H04 synthetic cancellation');
    assert.ok(current);
    const before=await get(`api/tasks/${current.id}/runs`);assert.equal(before.length,1);
    await page.getByLabel('输入工作要求',{exact:true}).fill('H04 next draft');
    assert.equal(await page.getByRole('button',{name:'交给智能体执行',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'停止执行',exact:true}).click();
    await page.locator('.conversation-state').filter({hasText:'已停止'}).waitFor();
    assert.equal(await page.getByLabel('输入工作要求',{exact:true}).inputValue(),'H04 next draft');
    const after=await get(`api/tasks/${current.id}/runs`);assert.equal(after.length,1);assert.equal(after[0].id,before[0].id);assert.equal(after[0].status,'stopped');
    assert.equal(disconnected,true);
    await page.getByLabel('输入工作要求',{exact:true}).fill('');
    const admin=await browser.newContext();
    try {
      assert.equal((await admin.request.post(origin+'api/login',{data:{username:'test-admin',password:process.env.H04_TEST_PASSWORD}})).status(),200);
      const users=await (await admin.request.get(origin+'api/users')).json();
      const alice=users.find(user=>user.username==='alice');
      await send(page,'LONG H04 synthetic revocation');
      await page.getByRole('button',{name:'开始执行',exact:true}).click();
      await page.waitForFunction(async id=>{
        const rows=await fetch(`/api/tasks/${id}/runs`).then(response=>response.json());
        return Array.isArray(rows) && rows.length===2 && rows.at(-1).status==='running';
      },current.id);
      assert.equal((await admin.request.patch(origin+`api/users/${alice.id}`,{data:{ai_enabled:false}})).status(),200);
      await page.getByRole('heading',{name:'登录工作台',exact:true}).waitFor();
      assert.equal(await page.locator('.conversation-entry').count(),0);
      assert.equal((await context.request.get(origin+'api/conversations')).status(),401);
    } finally {await admin.close();}
  });
  console.log(JSON.stringify(evidence));
} finally {await browser?.close();await server.close();}
