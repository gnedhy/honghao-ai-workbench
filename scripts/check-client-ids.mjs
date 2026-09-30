import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

// Run: node scripts/check-client-ids.mjs. All business requests are intercepted.
const entry = process.cwd().replaceAll("\\", "/") + "/client-id-check.tsx";
const server = await createServer({ configFile: false, plugins: [react(), {
  name: "client-id-check",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url.split("?")[0] !== "/client-id-check") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/client-id-check", '<html><head><title>Client ID check</title></head><body><div id="root"></div><script type="module" src="/client-id-check.tsx"></script></body></html>'));
    });
  },
  resolveId(id) { if (id === "/client-id-check.tsx") return entry; },
  load(id) {
    if (id !== entry) return;
    return `import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {SalesCalculator} from '/src/workbenches/SalesCalculator';
import {Composer} from '/src/components/Composer';
import '/src/styles.css';
const product={id:'test',code:'测试产品',name:'测试产品',source:'research',department:'测试',latest_cost:'4.99',inventory_cost:'5.10',status:'ready',special_allocation:false,source_version:'test'};
window.submissions=[];
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).get('kind')==='composer'
  ? h(Composer,{compact:true,onSubmit:async(message,key)=>{window.submissions.push({message,key});return window.submissions.length!==1;}})
  : h(SalesCalculator,{products:[product],accessLevel:3}));`;
  },
}], server: { host: "127.0.0.1", port: 0, allowedHosts: ["workbench.test"] } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP workbench.test 127.0.0.1", "--no-proxy-server"] });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
try {
  for (const host of ["workbench.test", "127.0.0.1"]) {
    const page = await browser.newPage();
    const errors = [], payloads = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { saved: [] } });
      assert.ok(route.request().url().endsWith("/calculator/evaluate"), "Unexpected business request");
      const payload = route.request().postDataJSON();
      payloads.push(payload);
      await route.fulfill({ json: { source: { ...payload.source, cost: "4.99" }, default_allocation_tiers: [], results: payload.panels.map(panel => ({ id: panel.id, error: null, result: { price: "8.22", target_cost: null, cost_gap: null, allocation_amount: "0.5", trail: [] } })) } });
    });
    const url = `http://${host}:${port}/client-id-check`;
    await page.goto(url);
    assert.equal(await page.evaluate(() => isSecureContext), host === "127.0.0.1");
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), host === "127.0.0.1" ? "function" : "undefined");
    try { await page.getByRole("article", { name: "面板 2", exact: true }).waitFor({ timeout: 5000 }); }
    catch { throw new Error(errors.join("; ") || "Calculator failed to initialize"); }
    await page.getByRole("button", { name: "新增对比面板" }).click();
    await page.getByRole("button", { name: "复制面板 1", exact: true }).click();
    const panel = page.getByRole("article", { name: "面板 1", exact: true });
    await Promise.all([page.waitForResponse("**/calculator/evaluate"), panel.getByRole("button", { name: "增加系数" }).click()]);
    const latest = payloads.at(-1);
    assert.equal(latest.panels.length, 4);
    assert.equal(latest.panels[0].steps.length, 7);
    const ids = latest.panels.flatMap(panel => [panel.id, ...panel.steps.map(step => step.id)]);
    ids.forEach(id => assert.match(id, uuid));
    assert.equal(new Set(ids).size, ids.length);
    await panel.getByRole("button", { name: "恢复现行公式" }).click();
    await panel.getByLabel("面板 1第 6 步名称", { exact: true }).waitFor();
    await page.goto(url + "?kind=composer");
    await page.locator("textarea").fill("重试同一条消息");
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    await send.click();
    await send.click();
    assert.equal(await page.locator("textarea").inputValue(), "");
    await page.locator("textarea").fill("下一条消息");
    await send.click();
    const submissions = await page.evaluate(() => window.submissions);
    assert.equal(submissions.length, 3);
    submissions.forEach(row => assert.match(row.key, uuid));
    assert.equal(submissions[0].key, submissions[1].key);
    assert.notEqual(submissions[1].key, submissions[2].key);
    assert.deepEqual(errors, []);
    console.log(`PASS ${host}: calculator initialization/add/copy/steps/reset and submission retry IDs`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
