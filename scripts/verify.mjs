import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const { values } = parseArgs({ options: { scope: { type: 'string', default: 'all' } } });
const scope = values.scope;
assert.ok(['all', 'frontend', 'sales', 'procurement', 'research'].includes(scope), 'Unknown verification scope');
assert.ok(process.env.npm_execpath, 'Run via npm run verify');
const started = performance.now();
const environment = { ...process.env, PYTHONUTF8: '1', UV_LOCKED: '1' };
delete environment.W4_QUOTE_ONLY; // A complete gate must include W2 recovery, regardless of local debug filters.
delete environment.W8_RED; // W8 original-source reproduction is never a gate.
delete environment.W7_RED; // Original-component reproduction cannot replace the current candidate in a gate.
function run(command, args) {
  const begin = performance.now();
  console.log(`\nRUN ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: environment });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`PASS stage ${(performance.now() - begin).toFixed(0)} ms`);
}
const npm = (script, args = []) => run(process.execPath, [process.env.npm_execpath, 'run', script, ...(args.length ? ['--', ...args] : [])]);
const files = readdirSync('tests').filter(file => file.startsWith('test_') && file.endsWith('.py'));
const apiFiles = scope === 'all' ? [] : files.filter(file =>
  scope === 'sales' ? file.startsWith('test_sales') :
  scope === 'procurement' ? /test_(procurement|research|sales)/.test(file) :
  scope === 'research' ? /test_(research|sales)/.test(file) || file === 'test_procurement_rd5.py' : false
).sort().map(file => 'tests/' + file);
npm('test:count'); // Always the complete collection and existing count floor.
npm('check:frontend');
npm('test:frontend');
npm('test:browser'); // Shared controls: retain all small mounted-consumer checks.
npm('build', ['--outDir', `.scratch/verify/${scope}/dist`]);
npm('security:check');
if (scope !== 'frontend') npm('test:api', [...apiFiles, '--junitxml', `.scratch/verify/${scope}/api-results.xml`]);
console.log(`PASS verify scope=${scope}; ${(performance.now() - started).toFixed(0)} ms`);
if (scope !== 'all') console.log('This scoped result does not replace the complete submission gate: npm run verify');
