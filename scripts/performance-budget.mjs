import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

export const POLICY_FILE = 'scripts/performance-budgets.json';
export const INTRODUCTION_BASE = 'ea611e42b85b68ee7e2543849cdda73e842f4e63';
export function loadPolicy() { return JSON.parse(readFileSync(POLICY_FILE, 'utf8')); }
export function validatePolicy(policy, workbenches) {
  assert.equal(policy.schema, 1, 'Unknown performance budget schema');
  const fixed = { browserSamples: 5, apiSamples: 9, cpuSlowdown: 4, procurementRows: 2000, researchRows: 500, salesProducts: 2000, apiProducts: 200, apiMaterials: 2000, apiHistoryPerProduct: 20, apiFormulaLines: 12, apiCalculatorPanels: 12 };
  for (const [key, value] of Object.entries(fixed)) assert.equal(policy.fixture[key], value, 'Performance sample must remain fixed: ' + key);
  for (const value of Object.values(policy.fixture)) assert.ok(Number.isInteger(value) && value > 0, 'Invalid performance workload dimension');
  const expected = ['bundle.initialJsKiB', 'bundle.initialCssKiB', 'bundle.totalJsKiB', 'bundle.totalCssKiB'];
  for (const row of workbenches.filter(row => row.entry !== null)) expected.push(`bundle.${row.id}.incrementalJsKiB`);
  for (const row of workbenches.filter(row => row.entry !== null)) for (const suffix of ['readyMedianMs', 'readyMaxMs', 'filterMedianMs', 'filterMaxMs', 'requests']) expected.push(`browser.${row.id}.${suffix}`);
  assert.ok(Array.isArray(policy.paginationModules) && new Set(policy.paginationModules).size === policy.paginationModules.length, 'Invalid pagination performance modules');
  assert.ok(['procurement', 'research'].every(id => policy.paginationModules.includes(id)), 'Missing protected pagination measurement');
  for (const id of policy.paginationModules) {
    assert.ok(workbenches.some(row => row.entry !== null && row.id === id), 'Unimplemented pagination performance module');
    expected.push(`browser.${id}.pageMedianMs`, `browser.${id}.pageMaxMs`);
  }
  assert.ok(policy.apiProfiles && typeof policy.apiProfiles === 'object', 'Missing API performance profiles');
  const implemented = workbenches.filter(row => row.entry !== null).map(row => row.id);
  for (const [id, profile] of Object.entries(policy.apiProfiles)) {
    assert.match(id, /^[A-Za-z][A-Za-z0-9]+$/, 'Unsafe API profile ID');
    assert.ok(implemented.includes(profile.module) && /^tests\/test_[A-Za-z0-9_]+\.py::test_[A-Za-z0-9_]+$/.test(profile.test), 'Invalid API performance profile');
    for (const suffix of ['medianMs', 'maxMs', 'sqlCalls']) expected.push(`api.${id}.${suffix}`);
  }
  for (const id of implemented) assert.ok(Object.values(policy.apiProfiles).some(profile => profile.module === id), `${id}: no API performance profile`);
  assert.deepEqual(Object.keys(policy.limits).sort(), expected.sort(), 'Missing or unknown performance budgets');
  for (const [id, limit] of Object.entries(policy.limits)) assert.ok(Number.isFinite(limit) && limit >= 0 && (id.endsWith('.requests') || limit > 0), `Invalid performance limit: ${id}`);
}
export function validateBudgetChanges(policy, previous, revisions = []) {
  for (const id of previous.paginationModules) assert.ok(policy.paginationModules.includes(id), 'Protected pagination profile removed');
  for (const [key, value] of Object.entries(previous.fixture)) assert.equal(policy.fixture[key], value, 'Fixed performance workload changed: ' + key);
  for (const [id, limit] of Object.entries(previous.limits)) {
    assert.ok(Object.hasOwn(policy.limits, id), `Protected performance budget removed: ${id}`);
    if (policy.limits[id] > limit) {
      assert.ok(revisions.some(row => row.metric === id && row.from === limit && row.to === policy.limits[id] && typeof row.reason === 'string' && row.reason.trim().length >= 20 && typeof row.evidence === 'string' && row.evidence.trim().length >= 20), `Performance budget relaxed without current review evidence: ${id}`);
    }
  }
  for (const [id, profile] of Object.entries(previous.apiProfiles)) assert.deepEqual(policy.apiProfiles[id], profile, `Protected API performance profile changed: ${id}`);
}
export function currentBudgetRevisions(current, previous = []) {
  assert.ok(Array.isArray(current) && Array.isArray(previous), 'Invalid budget revision records');
  const fields = ['metric', 'from', 'to', 'reason', 'evidence'];
  assert.ok([...current, ...previous].every(row => row && typeof row === 'object'), 'Invalid budget revision record');
  return current.filter(row => !previous.some(old => fields.every(field => row[field] === old[field])));
}
export function summarize(samples, expectedCount) {
  assert.equal(samples.length, expectedCount, 'Missing performance samples');
  assert.ok(samples.every(value => Number.isFinite(value) && value >= 0), 'Invalid performance sample');
  const values = [...samples].sort((a, b) => a - b);
  return { median: values[Math.floor(values.length / 2)], max: values.at(-1) };
}
export function enforceMetrics(metrics, policy, prefix) {
  const expected = Object.keys(policy.limits).filter(id => id.startsWith(prefix));
  assert.deepEqual(Object.keys(metrics).sort(), expected.sort(), `Incomplete ${prefix} measurements`);
  for (const id of expected) {
    assert.ok(Number.isFinite(metrics[id]) && metrics[id] >= 0, `Invalid measurement: ${id}`);
    assert.ok(metrics[id] <= policy.limits[id], `${id}: ${metrics[id].toFixed(2)} exceeds ${policy.limits[id]}`);
  }
}
export function bundleMetrics(manifest, readAsset, workbenches, emittedAssets) {
  assert.ok(manifest['index.html']?.isEntry, 'Missing production entry manifest');
  const closure = key => {
    const seen = new Set(), assets = new Set();
    const visit = name => {
      assert.ok(manifest[name], `Unresolved manifest import: ${name}`);
      if (seen.has(name)) return;
      seen.add(name);
      const row = manifest[name]; assets.add(row.file);
      for (const css of row.css ?? []) assets.add(css);
      for (const dependency of row.imports ?? []) visit(dependency);
    };
    visit(key); return assets;
  };
  const safe = file => assert.ok(typeof file === 'string' && !path.posix.isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..'), 'Unsafe manifest asset');
  const sizes = new Map();
  const size = file => { safe(file); if (!sizes.has(file)) sizes.set(file, gzipSync(readAsset(file), { level: 9 }).length / 1024); return sizes.get(file); };
  const sum = (assets, extension) => [...assets].filter(file => file.endsWith(extension)).reduce((total, file) => total + size(file), 0);
  const initial = closure('index.html');
  const all = new Set(emittedAssets ?? Object.values(manifest).flatMap(row => [row.file, ...(row.css ?? [])]));
  const metrics = { 'bundle.initialJsKiB': sum(initial, '.js'), 'bundle.initialCssKiB': sum(initial, '.css'), 'bundle.totalJsKiB': sum(all, '.js'), 'bundle.totalCssKiB': sum(all, '.css') };
  for (const row of workbenches.filter(row => row.entry !== null)) {
    assert.ok(manifest[row.entry]?.isDynamicEntry, `${row.id}: module must remain a lazy production entry`);
    assert.ok(!initial.has(manifest[row.entry].file), `${row.id}: lazy module is statically loaded by the initial entry`);
    const module = closure(row.entry);
    metrics[`bundle.${row.id}.incrementalJsKiB`] = sum(new Set([...module].filter(file => !initial.has(file))), '.js');
  }
  return metrics;
}

export function validateMeasurementReport(report, policy, kind) {
  assert.equal(report.schema, 1, 'Invalid performance report schema'); assert.equal(report.kind, kind, 'Wrong performance report kind');
  enforceMetrics(report.metrics, policy, kind + '.');
  if (kind === 'bundle') return;
  assert.deepEqual(report.fixture, policy.fixture, 'Performance report used a different workload');
  const ids = kind === 'api' ? Object.keys(policy.apiProfiles) : Object.keys(policy.limits).filter(id => id.endsWith('.readyMedianMs')).map(id => id.split('.')[1]);
  assert.deepEqual(Object.keys(report.samples).sort(), [...ids].sort(), 'Missing performance profiles');
  for (const id of ids) {
    const row = report.samples[id], prefix = `${kind}.${id}.`;
    if (kind === 'api') {
      const timing = summarize(row.milliseconds, policy.fixture.apiSamples), counts = summarize(row.sqlCalls, policy.fixture.apiSamples);
      assert.ok(row.sqlCalls.every(value => Number.isInteger(value) && value > 0), 'API SQL measurement is missing');
      assert.equal(report.metrics[prefix + 'medianMs'], timing.median); assert.equal(report.metrics[prefix + 'maxMs'], timing.max); assert.equal(report.metrics[prefix + 'sqlCalls'], counts.max);
    } else {
      const ready = summarize(row.ready, policy.fixture.browserSamples), input = summarize(row.filtered, policy.fixture.browserSamples), counts = summarize(row.requestCounts, policy.fixture.browserSamples);
      assert.ok(row.requestCounts.every(value => Number.isInteger(value) && value >= 0), 'Invalid browser request count');
      assert.equal(report.metrics[prefix + 'readyMedianMs'], ready.median); assert.equal(report.metrics[prefix + 'readyMaxMs'], ready.max);
      assert.equal(report.metrics[prefix + 'filterMedianMs'], input.median); assert.equal(report.metrics[prefix + 'filterMaxMs'], input.max); assert.equal(report.metrics[prefix + 'requests'], counts.max);
      if (policy.paginationModules.includes(id)) {
        const paging = summarize(row.paged, policy.fixture.browserSamples);
        assert.equal(report.metrics[prefix + 'pageMedianMs'], paging.median); assert.equal(report.metrics[prefix + 'pageMaxMs'], paging.max);
      }
    }
  }
}
