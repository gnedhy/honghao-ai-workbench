import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dependencyFindings, reactDiagnostics, diagnosticEntry, entryKey } from '../scripts/check-frontend-quality.mjs';

test('dependency boundaries reject reverse imports, hidden type cycles and unapproved reuse', () => {
  const policy = { entries: ['src/workbenches/SalesWorkbench.tsx'], businessComponents: {}, compatibility: [
    { from: 'src/workbenches/ResearchMaterialPrices.tsx', to: 'src/workbenches/ProcurementWorkbench.tsx', symbols: ['ledgerCell'] },
  ] };
  const source = {
    'src/components/Input.tsx': 'export const Input = 1;',
    'src/api.ts': 'export const api = 1;',
    'src/types.ts': 'export type Value = number;',
    'src/workbenches/WorkbenchModuleSlot.tsx': "export const load = () => import('./SalesWorkbench');",
    'src/workbenches/SalesWorkbench.tsx': "import type { Value } from '../types'; export const SalesWorkbench = 1;",
    'src/workbenches/ProcurementWorkbench.tsx': 'export const ledgerCell = 1; export const internal = 2;',
    'src/workbenches/ResearchMaterialPrices.tsx': "import { ledgerCell } from './ProcurementWorkbench';",
  };
  assert.deepEqual(dependencyFindings(source, policy), []);
  const rejects = (file: string, text: string, pattern: RegExp) => assert.match(dependencyFindings({ ...source, [file]: text }, policy).join('\n'), pattern);
  rejects('src/components/Input.tsx', "import { api } from '../api';", /shared control depends/);
  rejects('src/workbenches/ResearchMaterialPrices.tsx', "import { internal } from './ProcurementWorkbench';", /unapproved internal import/);
  rejects('src/workbenches/ResearchMaterialPrices.tsx', "export * from './ProcurementWorkbench';", /unapproved internal import/);
  rejects('src/api.ts', "export type Value = import('./workbenches/SalesWorkbench').Value;", /unapproved internal import/);
  rejects('src/types.ts', "export type Value = import('./workbenches/SalesWorkbench').Value;", /dependency cycle/);
  rejects('src/api.ts', "export * from './missing';", /unresolved local module/);
  rejects('src/api.ts', 'const module = import(location.hash);', /computed module import/);
  rejects('src/components/Input.tsx', "fetch('/api/test');", /network request/);
  const via = { ...source, 'src/components/Input.tsx': "import '../gateway';", 'src/gateway.ts': "export * from './api';" };
  assert.match(dependencyFindings(via, policy).join('\n'), /shared control reaches/);
  const typeReverse = { ...source, 'src/components/Input.tsx': "import type { Size } from './SettingsDialog';", 'src/components/SettingsDialog.tsx': 'export type Size = number;' };
  assert.match(dependencyFindings(typeReverse, { ...policy, businessComponents: { 'src/components/SettingsDialog.tsx': {} } }).join('\n'), /shared control depends/);
  const cycle = { ...source, 'src/api.ts': "export * from './components/Input';", 'src/components/Input.tsx': "export * from '../api';" };
  assert.match(dependencyFindings(cycle, policy).join('\n'), /dependency cycle/);
  const extended = {
    'src/workbenches/FinanceWorkbench.tsx': "import { model } from './financeModel'; export const FinanceWorkbench = model;",
    'src/workbenches/financeModel.ts': 'export const model = 1;',
    'src/workbenches/SalesWorkbench.tsx': 'export const sales = 1;',
  };
  const extendedPolicy = { entries: ['src/workbenches/FinanceWorkbench.tsx', 'src/workbenches/SalesWorkbench.tsx'], businessComponents: {}, compatibility: [] };
  assert.deepEqual(dependencyFindings(extended, extendedPolicy), [], 'registered new module keeps its internal boundary');
  assert.match(dependencyFindings({ ...extended, 'src/workbenches/financeModel.ts': "import { sales } from './SalesWorkbench';" }, extendedPolicy).join('\n'), /unapproved internal import/, 'new module cannot silently consume another module internals');
  const overlapping = {...extended, 'src/workbenches/SalesopsWorkbench.tsx': "import { model } from './salesopsModel'; export const SalesopsWorkbench = model;", 'src/workbenches/salesopsModel.ts': 'export const model = 1;'};
  const overlappingPolicy = {...extendedPolicy, entries:[...extendedPolicy.entries,'src/workbenches/SalesopsWorkbench.tsx']};
  assert.deepEqual(dependencyFindings(overlapping, overlappingPolicy), []);
  assert.match(dependencyFindings({...overlapping,'src/workbenches/salesopsModel.ts': "import { sales } from './SalesWorkbench';"},overlappingPolicy).join('\n'), /unapproved internal import/);
  assert.match(dependencyFindings({...overlapping,'src/workbenches/SalesWorkbench.tsx': "import { model } from './salesopsModel';"},overlappingPolicy).join('\n'), /unapproved internal import/);
});

test('the installed React checker rejects four controlled faults and accepts their correction', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'honghao-react-check-'));
  const file = path.join(dir, 'Probe.tsx');
  try {
    const bad = `import { useEffect, useState } from 'react';
export function Probe({ enabled, value }) {
  if (enabled) useState(0);
  useEffect(() => { console.log(value); }, []);
  return <div title="a" title="b">{[1, 2].map(n => <span>{n}</span>)}</div>;
}`;
    writeFileSync(file, bad);
    const findings = reactDiagnostics([file]);
    assert.deepEqual(new Set(findings.map(row => row.code)), new Set([
      'react-hooks(rules-of-hooks)', 'react-hooks(exhaustive-deps)', 'react(jsx-key)', 'react(jsx-no-duplicate-props)',
    ]));
    const hook = findings.find(row => row.code === 'react-hooks(exhaustive-deps)')!;
    const key = entryKey(diagnosticEntry(hook, bad));
    writeFileSync(file, '\n' + bad);
    const moved = reactDiagnostics([file]).find(row => row.code === hook.code)!;
    assert.equal(entryKey(diagnosticEntry(moved, '\n' + bad)), key, 'line moves preserve the reviewed Hook');
    const edited = bad.replace('console.log(value)', 'console.warn(value)');
    writeFileSync(file, edited);
    assert.notEqual(entryKey(diagnosticEntry(reactDiagnostics([file]).find(row => row.code === hook.code)!, edited)), key, 'an edited violation cannot reuse the old baseline');
    writeFileSync(file, `import { useEffect, useState } from 'react';
export function Probe({ value }) {
  useState(0);
  useEffect(() => { console.log(value); }, [value]);
  return <div title="a">{[1, 2].map(n => <span key={n}>{n}</span>)}</div>;
}`);
    assert.deepEqual(reactDiagnostics([file]), []);
  } finally { unlinkSync(file); rmdirSync(dir); }
});
