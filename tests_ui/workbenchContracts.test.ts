import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontendInventory, validateContracts, validateChanges, scopeFiles } from '../scripts/check-workbench-contracts.mjs';

const id = 'tests/test_probe.py::test_probe';
const sources = {
  'src/types.ts': 'export type WorkbenchId = "probe"; export type ProbePage = "list"; export const PROBE_PAGE_LABELS={list:"列表"};',
  'src/workbenchRegistry.ts': 'export const workbenches=[{id:"probe"}] as const; export const workbenchPages={probe:[{id:"list"}]}; export const workbenchLabels={probe:"示例"};',
  'src/workbenches/WorkbenchModuleSlot.tsx': 'const Probe=lazy(()=>import("./ProbeWorkbench")); export const slot=props.workbenchId === "probe" ? <Probe/> : null;',
  'src/workbenches/ProbeWorkbench.tsx': 'export const ProbeWorkbench=()=>null;',
  'scripts/check-probe.mjs': 'await scenario("probe-save",async()=>{});',
  'tests_ui/probe.test.ts': 'test("probe-precision",()=>{});',
};
const row = {id:'probe',status:'implemented',entry:'src/workbenches/ProbeWorkbench.tsx',pageType:'ProbePage',pageLabels:'PROBE_PAGE_LABELS',pages:['list'],owner:'测试维护者',permissions:'只读授权',data:'合成数据',lifecycle:'清理旧回包',exits:'共享退出',compatibility:'历史保留',recovery:'回退不删数据',consumers:['src/workbenches/ProbeWorkbench.tsx'],apiPatterns:['test_probe*.py'],apiTests:[id],browserTests:[{file:'scripts/check-probe.mjs',id:'probe-save',apiTest:id}]};
const contract = {schema:1,workbenches:[row]};
const backend = {workbenches:['probe'],typeIds:['probe'],scopes:['probe'],browserWrappers:{'scripts/check-probe.mjs':[id]}};
const exists = (file: string) => Object.hasOwn(sources,file);

test('extension contracts reject missing registry, backend scope, lazy entry, pages and live regression',()=>{
  assert.equal(validateContracts(contract,sources,backend,[id],exists).ids[0],'probe');
  assert.throws(()=>validateContracts(contract,{...sources,'src/workbenchRegistry.ts':sources['src/workbenchRegistry.ts'].replace('[{id:"probe"}]','[]')},backend,[id],exists),/Registry/);
  assert.throws(()=>validateContracts(contract,sources,{...backend,scopes:[]},[id],exists),/Backend scopes/);
  assert.throws(()=>validateContracts(contract,{...sources,'src/workbenches/WorkbenchModuleSlot.tsx':sources['src/workbenches/WorkbenchModuleSlot.tsx'].replace('./ProbeWorkbench','./Missing')},backend,[id],exists),/Lazy entry/);
  assert.throws(()=>validateContracts({schema:1,workbenches:[{...row,pages:['list','detail']}]},sources,backend,[id],exists),/page type/);
  assert.throws(()=>validateContracts(contract,sources,backend,[],exists),/uncollected/);
  assert.throws(()=>validateContracts(contract,sources,{...backend,browserWrappers:{}},[id],exists),/not connected/);
  assert.throws(()=>validateContracts(contract,sources,backend,[id],exists,{entries:[]}),/Quality boundary/);
  const outside = 'tests/test_other_ui.py::test_browser';
  assert.throws(()=>validateContracts({schema:1,workbenches:[{...row,browserTests:[{...row.browserTests[0],apiTest:outside}]}]},sources,{...backend,browserWrappers:{'scripts/check-probe.mjs':[outside]}},[id,outside],exists),/outside declared scope/);
  assert.throws(()=>frontendInventory({...sources,'src/types.ts':'export type WorkbenchId=string;'}),/Nonliteral/);
});

test('new module scope collects its declared files and unknown or empty scope fails closed',()=>{
  assert.deepEqual(scopeFiles(contract,'probe',['test_other.py','test_probe_save.py']),['tests/test_probe_save.py']);
  assert.deepEqual(scopeFiles(contract,'all',[]),[]);
  assert.equal(scopeFiles(contract,'frontend',[]),null);
  assert.throws(()=>scopeFiles(contract,'other',[]),/Unknown/);
  assert.throws(()=>scopeFiles(contract,'probe',['test_other.py']),/no files/);
});

test('each product diff needs a current complete declaration tied to collected and executed consumers',()=>{
  const changed=['src/workbenches/ProbeWorkbench.tsx'];
  const declaration={schema:1,kind:'business',summary:'新增保存',modules:['probe'],files:changed,consumers:changed,permissions:'复核授权',data:'合成输入',lifecycle:'保留草稿',exits:'取消保持',compatibility:'不改历史',recovery:'代码回退',verification:{api:[id],node:[],browser:[{file:'scripts/check-probe.mjs',id:'probe-save',apiTest:id}]}};
  const check=(value: unknown)=>validateChanges(changed,{'docs/changes/probe.json':value},contract,sources,[id],backend.browserWrappers);
  check(declaration);
  assert.throws(()=>validateChanges(changed,{},contract,sources,[id]),/Missing current change/);
  assert.throws(()=>check({...declaration,recovery:''}),/missing recovery/);
  assert.throws(()=>check({...declaration,files:['src/unchanged.ts']}),/not in this product diff/);
  assert.throws(()=>check({...declaration,verification:{api:['tests/test_missing.py::test_missing'],node:[],browser:[]}}),/uncollected/);
  assert.throws(()=>check({...declaration,verification:{api:[id],node:[],browser:[{file:'scripts/check-probe.mjs',id:'probe-save',apiTest:'missing'}]}}),/not connected/);
  validateChanges(['docs/README.md','scripts/verify.mjs'],{},contract,sources,[id]);
});


test('chat contracts use real module IDs and require collected browser consumers',()=>{
  const extendedSources={...sources,'src/types.ts':sources['src/types.ts']+'export type Section="chat"|"tasks"|"workbench";'};
  const extendedBackend={...backend,modules:['chat','tasks','workbench']};
  const chat={...row,id:'chat'};
  const extended={...contract,modules:[chat]};
  validateContracts(extended,extendedSources,extendedBackend,[id],exists);
  assert.deepEqual(scopeFiles(extended,'chat',['test_probe_save.py']),['tests/test_probe_save.py']);
  assert.throws(()=>validateContracts({...extended,modules:[{...chat,id:'fake'}]},extendedSources,extendedBackend,[id],exists),/unknown non-workbench/);
  assert.throws(()=>validateContracts({...extended,modules:[{...chat,browserTests:[]}]},extendedSources,extendedBackend,[id],exists),/no actual browser/);
  assert.throws(()=>validateContracts(extended,extendedSources,{...extendedBackend,browserWrappers:{}},[id],exists),/not connected|no API wrapper/);
});
