import test from "node:test";
import assert from "node:assert/strict";
import { confirmWorkbenchLeave } from "../src/components/interactionNavigation.ts";

test("导航按顺序等待编辑器确认，确认之前不继续", async () => {
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { value: target, configurable: true });
  let approve!: (value: boolean) => void;
  let second = false;
  target.addEventListener("procurement-before-leave", event => (event as CustomEvent).detail.waitUntil(new Promise<boolean>(resolve => { approve = resolve; })));
  target.addEventListener("research-before-leave", () => { second = true; });
  const result = confirmWorkbenchLeave();
  await Promise.resolve();
  assert.equal(second, false);
  approve(true);
  assert.equal(await result, true);
  assert.equal(second, true);
});
test("取消与忙碌阻止原导航，不继续第二个工作台", async () => {
  for (const busy of [true, false]) {
    const target = new EventTarget();
    Object.defineProperty(globalThis, "window", { value: target, configurable: true });
    target.addEventListener("procurement-before-leave", event => busy ? event.preventDefault() : (event as CustomEvent).detail.waitUntil(Promise.resolve(false)));
    target.addEventListener("research-before-leave", () => assert.fail("取消后不应导航"));
    assert.equal(await confirmWorkbenchLeave(), false);
  }
});
test("同工作台任一编辑器拒绝均不能离开", async () => {
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { value: target, configurable: true });
  target.addEventListener("procurement-before-leave", event => { (event as CustomEvent).detail.waitUntil(Promise.resolve(true)); (event as CustomEvent).detail.waitUntil(Promise.resolve(false)); });
  assert.equal(await confirmWorkbenchLeave(), false);
});
