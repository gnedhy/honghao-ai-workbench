import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observeDOMMeasurement } from '../scripts/performance-dom.mjs';

test('browser performance timer excludes driver waits and retains actual delayed rendering', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="go">Go</button><div id="result">before</div>');
    await page.evaluate(() => document.querySelector('#go')!.addEventListener('click', () => {
      setTimeout(() => { document.querySelector('#result')!.textContent = 'done'; }, 200);
    }));
    await page.evaluate(observeDOMMeasurement, { trigger: '#go', event: 'click', selector: '#result', count: 1, text: 'done', property: 'measured' });
    await page.click('#go');
    // The original cross-process timer includes this unrelated driver wait.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const measured = await page.evaluate(() => (window as any).measured);
    assert.ok(measured >= 200 && measured < 900, 'Measure actual rendering, excluding driver waits');
    await page.evaluate(observeDOMMeasurement, { trigger: '#go', event: 'click', selector: '#result', count: 2, text: 'done', property: 'missing' });
    await page.click('#go');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await page.evaluate(() => (window as any).missing), null, 'Missing result cannot complete a measurement');
  } finally { await browser.close(); }
});
