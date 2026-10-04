import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleMetrics, enforceMetrics, summarize, validatePolicy, validateBudgetChanges, currentBudgetRevisions, validateMeasurementReport } from '../scripts/performance-budget.mjs';

const policy = JSON.parse(readFileSync('scripts/performance-budgets.json', 'utf8'));
const {workbenches} = JSON.parse(readFileSync('scripts/workbench-contracts.json', 'utf8'));
const modules = [{id:'probe',entry:'src/Probe.tsx'}];
const manifest = {
  'index.html':{isEntry:true,file:'assets/main.js',imports:['_shared'],dynamicImports:['src/Probe.tsx'],css:['assets/main.css']},
  '_shared':{file:'assets/shared.js'},
  'src/Probe.tsx':{isDynamicEntry:true,file:'assets/probe.js',imports:['_shared','index.html']},
};
const read = (file: string) => Buffer.from(file.repeat(100));

test('performance bundle counts static transitive assets once and preserves lazy module increments',()=>{
  const measurements=bundleMetrics(manifest,read,modules);
  assert.ok(measurements['bundle.initialJsKiB']>0);
  assert.ok(measurements['bundle.totalJsKiB']>measurements['bundle.initialJsKiB']);
  assert.equal(measurements['bundle.totalJsKiB']-measurements['bundle.initialJsKiB'],measurements['bundle.probe.incrementalJsKiB']);
  const merged={...manifest,'index.html':{...manifest['index.html'],imports:['_shared','src/Probe.tsx']}};
  assert.throws(()=>bundleMetrics(merged,read,modules),/statically loaded/);
  assert.ok(bundleMetrics(manifest,read,modules,['assets/main.js','assets/shared.js','assets/probe.js','assets/worker.js','assets/main.css'])['bundle.totalJsKiB']>measurements['bundle.totalJsKiB']);
});

test('performance bundle rejects absent production assets, broken graphs and eager module entries',()=>{
  assert.throws(()=>bundleMetrics({},read,modules),/Missing production/);
  assert.throws(()=>bundleMetrics({...manifest,'_shared':{file:'../private.js'}},read,modules),/Unsafe/);
  assert.throws(()=>bundleMetrics({...manifest,'index.html':{...manifest['index.html'],imports:['missing']}},read,modules),/Unresolved/);
  assert.throws(()=>bundleMetrics({...manifest,'src/Probe.tsx':{...manifest['src/Probe.tsx'],isDynamicEntry:false}},read,modules),/lazy/);
  assert.throws(()=>bundleMetrics(manifest,()=>{throw new Error('missing file')},modules),/missing file/);
});

test('performance budgets reject oversized, missing, negative and nonfinite measurements',()=>{
  const sample={limits:{'bundle.one':10}};
  enforceMetrics({'bundle.one':10},sample,'bundle.');
  assert.throws(()=>enforceMetrics({'bundle.one':10.1},sample,'bundle.'),/exceeds/);
  assert.throws(()=>enforceMetrics({},sample,'bundle.'),/Incomplete/);
  assert.throws(()=>enforceMetrics({'bundle.one':NaN},sample,'bundle.'),/Invalid/);
  assert.throws(()=>enforceMetrics({'bundle.one':-1},sample,'bundle.'),/Invalid/);
});

test('performance workloads and new modules cannot evade measurement or silently relax limits',()=>{
  validatePolicy(policy,workbenches);
  assert.throws(()=>validatePolicy({...policy,fixture:{...policy.fixture,procurementRows:100}},workbenches),/fixed/);
  assert.throws(()=>validatePolicy({...policy,paginationModules:['procurement']},workbenches),/pagination/);
  assert.throws(()=>validatePolicy(policy,[...workbenches,{id:'finance',entry:'src/FinanceWorkbench.tsx'}]),/profile/);
  const increased=structuredClone(policy);increased.limits['bundle.initialJsKiB']++;
  assert.throws(()=>validateBudgetChanges(increased,policy),/relaxed/);
  assert.throws(()=>validateBudgetChanges(increased,policy,[{metric:'bundle.initialJsKiB',from:160,to:161,reason:'ok',evidence:'old pass'}]),/relaxed/);
  const record={metric:'bundle.initialJsKiB',from:160,to:161,reason:'A reviewed dependency requirement changes the bounded initial load.',evidence:'Current before/after measured byte sizes and both CI report links.'};
  validateBudgetChanges(increased,policy,currentBudgetRevisions([record]));
  assert.throws(()=>validateBudgetChanges(increased,policy,currentBudgetRevisions([{...record,extra:'unrelated metadata'}, {metric:'bundle.totalJsKiB',from:380,to:390,reason:record.reason,evidence:record.evidence}],[record])),/relaxed/);
  validateBudgetChanges(increased,policy,currentBudgetRevisions([{...record,evidence:record.evidence+' Updated candidate measurement.'}],[record]));
  const removed=structuredClone(policy);delete removed.limits['bundle.initialJsKiB'];
  assert.throws(()=>validateBudgetChanges(removed,policy),/removed/);
});

test('performance samples retain all cold runs and reject missing or invalid timing results',()=>{
  assert.deepEqual(summarize([9,2,4,1,3],5),{median:3,max:9});
  assert.throws(()=>summarize([1,2],5),/Missing/);
  assert.throws(()=>summarize([1,2,Infinity],3),/Invalid/);
});

test('performance receipts reject small workloads, omitted profiles and fabricated timing summaries',()=>{
  const p={fixture:{apiSamples:3,rows:200},limits:{'api.catalog.medianMs':10,'api.catalog.maxMs':20,'api.catalog.sqlCalls':4},apiProfiles:{catalog:{module:'sales'}}};
  const report={schema:1,kind:'api',fixture:p.fixture,metrics:{'api.catalog.medianMs':2,'api.catalog.maxMs':3,'api.catalog.sqlCalls':4},samples:{catalog:{milliseconds:[1,2,3],sqlCalls:[4,4,4]}}};
  validateMeasurementReport(report,p,'api');
  assert.throws(()=>validateMeasurementReport({...report,fixture:{...p.fixture,rows:20}},p,'api'),/different workload/);
  assert.throws(()=>validateMeasurementReport({...report,samples:{}},p,'api'),/Missing/);
  assert.throws(()=>validateMeasurementReport({...report,metrics:{...report.metrics,'api.catalog.medianMs':1}},p,'api'),/equal/);
  assert.throws(()=>validateMeasurementReport({...report,samples:{catalog:{...report.samples.catalog,milliseconds:[1,2]}}},p,'api'),/Missing/);
  const browserPolicy={fixture:{browserSamples:3},paginationModules:['ledger'],limits:{'browser.ledger.readyMedianMs':10,'browser.ledger.readyMaxMs':20,'browser.ledger.filterMedianMs':10,'browser.ledger.filterMaxMs':20,'browser.ledger.requests':0,'browser.ledger.pageMedianMs':10,'browser.ledger.pageMaxMs':20}};
  const browserReport={schema:1,kind:'browser',fixture:browserPolicy.fixture,metrics:{'browser.ledger.readyMedianMs':2,'browser.ledger.readyMaxMs':3,'browser.ledger.filterMedianMs':2,'browser.ledger.filterMaxMs':3,'browser.ledger.requests':0,'browser.ledger.pageMedianMs':2,'browser.ledger.pageMaxMs':3},samples:{ledger:{ready:[1,2,3],filtered:[1,2,3],requestCounts:[0,0,0],paged:[1,2,3]}}};
  validateMeasurementReport(browserReport,browserPolicy,'browser');
  assert.throws(()=>validateMeasurementReport({...browserReport,samples:{ledger:{...browserReport.samples.ledger,paged:[1,2]}}},browserPolicy,'browser'),/Missing/);
});
