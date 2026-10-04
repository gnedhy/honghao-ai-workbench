import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadPolicy, validatePolicy, validateMeasurementReport } from './performance-budget.mjs';

const { values } = parseArgs({ options: { scope: { type: 'string', default: 'all' } } });
try {
  const policy = loadPolicy(), { workbenches } = JSON.parse(readFileSync('scripts/workbench-contracts.json', 'utf8'));
  validatePolicy(policy, workbenches);
  for (const kind of values.scope === 'frontend' ? ['bundle', 'browser'] : ['bundle', 'browser', 'api']) validateMeasurementReport(JSON.parse(readFileSync(`.scratch/performance-budget/${kind}.json`, 'utf8')), policy, kind);
  console.log('PASS fresh performance measurements match every budget and sample');
} catch (error) { console.error(error.message); process.exitCode = 1; }
