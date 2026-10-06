import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

const api = new URL(process.env.H03_TEST_API ?? '');
assert.equal(api.hostname,'127.0.0.1');
assert.ok(api.port && !['8000','8080'].includes(api.port) && process.env.H03_TEST_PASSWORD);
const output = '.scratch/h03-ui';
mkdirSync(output,{recursive:true});
const server = await createServer({configFile:false,logLevel:'silent',plugins:[react()],
  cacheDir:output+'/vite-cache',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':api.origin}}});
const evidence=[];
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true});
  const origin=server.resolvedUrls.local[0];
  async function run(name, username, width, check) {
    const context=await browser.newContext({viewport:{width,height:1000}});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.name));
    const login=await context.request.post(origin+'api/login',{data:{username,password:process.env.H03_TEST_PASSWORD}});
    assert.equal(login.status(),200);
    const get=async path=>{const r=await context.request.get(origin+path);assert.equal(r.status(),200);return r.json();};
    try {
      await page.goto(origin);
      await page.locator('.sidebar__brand').waitFor();
      await check({page,context,get,origin});
      assert.deepEqual(errors,[]);
      await page.evaluate(async()=>Promise.all(document.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
      await page.screenshot({path:`${output}/${width}-${name}.png`,fullPage:true});
      evidence.push({name,status:'passed',width});
    } catch(error) {await page.screenshot({path:`${output}/${width}-${name}-failed.png`,fullPage:true});throw error;}
    finally {await context.close();}
  }
  await run('h03-actual-app-task-continuity','h03-alice',1440,async({page,get,origin})=>{
    await page.getByRole('button',{name:'新聊天',exact:true}).click();
    await page.getByLabel('输入工作要求',{exact:true}).fill('H03 synthetic first goal');
    await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.locator('.conversation-entry').filter({hasText:'H03 synthetic first goal'}).waitFor();
    const first=await get('api/tasks');assert.equal(first.length,1);
    await page.getByLabel('输入工作要求',{exact:true}).fill('H03 synthetic supplement');
    await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.locator('.conversation-entry').filter({hasText:'H03 synthetic supplement'}).waitFor();
    const tasks=await get('api/tasks');assert.equal(tasks.length,1);assert.equal(tasks[0].id,first[0].id);
    await page.getByRole('button',{name:'任务看板',exact:true}).click();
    await page.locator('tr').filter({hasText:'H03 synthetic first goal'}).waitFor();
    assert.equal(await page.locator('tbody tr').filter({hasText:'H03 synthetic first goal'}).count(),1);
    const create=await page.request.post(origin+'api/projects',{data:{title:'H03 synthetic project'}});
    assert.equal(create.status(),201);
    const project=await create.json();
    await page.reload();
    await page.getByRole('button',{name:'H03 synthetic first goal',exact:true}).click();
    const conv=(await get('api/conversations'))[0];
    const external=await page.request.patch(origin+`api/conversations/${conv.id}`,{data:{project_id:null,revision:conv.revision}});
    assert.equal(external.status(),200);
    await page.getByLabel('输入工作要求',{exact:true}).fill('H03 after conflict');
    await page.getByRole('button',{name:'选择项目',exact:true}).click();
    await page.getByRole('menuitem',{name:project.title,exact:true}).click();
    await page.getByRole('alert').filter({hasText:'已重新读取当前项目归属'}).waitFor();
    assert.equal(await page.getByLabel('输入工作要求',{exact:true}).inputValue(),'H03 after conflict');
    await page.getByRole('button',{name:'交给智能体执行',exact:true}).click();
    await page.locator('.conversation-entry').filter({hasText:'H03 after conflict'}).waitFor();
    const afterConflict=await get('api/tasks');assert.equal(afterConflict.length,1);assert.equal(afterConflict[0].id,first[0].id);
    assert.ok((await get(`api/conversations/${conv.id}/messages`)).every(message=>message.task_id===first[0].id));

    await page.getByRole('button',{name:'任务看板',exact:true}).click();
    await page.locator('tr').filter({hasText:'H03 synthetic first goal'}).waitFor();
    assert.equal(await page.locator('tbody tr').filter({hasText:'H03 synthetic first goal'}).count(),1);
    await page.reload();
    await page.getByRole('button',{name:'任务看板',exact:true}).click();
    await page.locator('tr').filter({hasText:'H03 synthetic first goal'}).waitFor();
    assert.equal(tasks[0].latest_run,null);
  });
  await run('h03-private-app-reader','h03-bob',390,async({page,get})=>{
    assert.deepEqual(await get('api/tasks'),[]);
    assert.deepEqual(await get('api/conversations'),[]);
    await page.getByRole('button',{name:'打开导航',exact:true}).click();
    await page.getByRole('button',{name:'新聊天',exact:true}).click();
    assert.equal(await page.locator('.conversation-entry').count(),0);
    await page.getByLabel('输入工作要求',{exact:true}).fill('H03 private mobile draft');
  });
  await run('h03-account-ai-grant-with-exit-protection','test-admin',1440,async({page,get})=>{
    await page.locator('.profile-trigger').click();
    await page.getByRole('menuitem',{name:'系统设置'}).click();
    await page.getByRole('button',{name:'用户管理',exact:true}).click();
    await page.getByRole('button',{name:'新建账号',exact:true}).click();
    await page.getByLabel('姓名',{exact:true}).fill('H03 UI created');
    await page.getByLabel('账号名',{exact:true}).fill('h03-ui-created');
    await page.getByRole('button',{name:'功能模块',exact:true}).click();
    const permission=page.getByRole('switch',{name:'项目 AI 使用权',exact:true});
    await permission.click();assert.equal(await permission.getAttribute('aria-checked'),'true');
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();
    await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    assert.equal(await permission.getAttribute('aria-checked'),'true');
    await page.evaluate(async()=>Promise.all(document.getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
    await page.screenshot({path:output+'/1440-ai-grant-editor.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await permission.scrollIntoViewIfNeeded();
    await permission.focus();await permission.press('Space');
    assert.equal(await permission.getAttribute('aria-checked'),'false');
    await permission.press('Space');assert.equal(await permission.getAttribute('aria-checked'),'true');
    const box=await permission.boundingBox();assert.ok(box && box.x>=0 && box.x+box.width<=390);
    await page.screenshot({path:output+'/390-ai-grant-editor.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'创建账号',exact:true}).click();
    await page.locator('.admin-create-form').waitFor({state:'hidden'});
    const account=(await get('api/users')).find(user=>user.username==='h03-ui-created');
    assert.equal(account.ai_enabled,true);
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  });
  console.log(JSON.stringify(evidence));
} finally {await browser?.close();await server.close();}
