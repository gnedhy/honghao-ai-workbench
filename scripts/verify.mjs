import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { scopeFiles } from './check-workbench-contracts.mjs';

const { values } = parseArgs({ options: { scope: { type: 'string', default: 'all' }, 'base-ref': { type: 'string', default: 'origin/main' } } });
const scope = values.scope;
assert.ok(process.env.npm_execpath, 'Run via npm run verify');
const base = values['base-ref'];
const baseline = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'], { encoding: 'utf8' });
assert.equal(baseline.status, 0, 'Verification requires an existing comparison commit; fetch origin/main or pass --base-ref');
const started = performance.now();
const environment = { ...process.env, PYTHONUTF8: '1', UV_LOCKED: '1' };
delete environment.PYTEST_ADDOPTS; // Collection and execution must share the same unfiltered scope.
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
const contract = JSON.parse(readFileSync('scripts/workbench-contracts.json', 'utf8'));
const apiFiles = scopeFiles(contract, scope, files);
npm('test:count', ['--base-ref', base, '--output', '.scratch/verify/collection.json']);
npm('check:regression', ['--base-ref', base]);
npm('check:extensions', ['--base-ref', base]);
npm('check:frontend');
npm('test:frontend');
npm('test:browser'); // Shared controls: retain all small mounted-consumer checks.
for (const kind of ['bundle', 'browser', 'api']) rmSync(`.scratch/performance-budget/${kind}.json`, { force: true });
npm('build', ['--outDir', `.scratch/verify/${scope}/dist`, '--manifest']);
npm('check:performance:bundle', ['--dist', `.scratch/verify/${scope}/dist`, '--base-ref', base]);
npm('check:performance:browser');
npm('check:performance:results', ['--scope', 'frontend']);
npm('security:check');
if (scope !== 'frontend') {
  const junit = `.scratch/verify/${scope}/api-results.xml`;
  rmSync(junit, { force: true }); // An old successful report cannot satisfy this execution.
  npm('test:api', ['-o', 'addopts=', '-q', ...apiFiles, '--junitxml', junit]);
  run('uv', ['--cache-dir', '.uv-cache', 'run', '--locked', 'python', 'scripts/check-api-execution.py', '--collection', '.scratch/verify/collection.json', '--junit', junit, '--files', ...apiFiles]);
  npm('check:performance:results');
}
console.log(`PASS verify scope=${scope}; ${(performance.now() - started).toFixed(0)} ms`);
if (scope !== 'all') console.log('This scoped result does not replace the complete submission gate: npm run verify');
