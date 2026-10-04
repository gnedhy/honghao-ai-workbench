import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadPolicy, validatePolicy, validateBudgetChanges, currentBudgetRevisions, bundleMetrics, enforceMetrics, INTRODUCTION_BASE, POLICY_FILE } from './performance-budget.mjs';

const { values } = parseArgs({ options: { dist: { type: 'string', default: '.scratch/verify/all/dist' }, 'base-ref': { type: 'string', default: 'origin/main' }, output: { type: 'string', default: '.scratch/performance-budget/bundle.json' } } });
try {
  const policy = loadPolicy(), { workbenches } = JSON.parse(readFileSync('scripts/workbench-contracts.json', 'utf8'));
  validatePolicy(policy, workbenches);
  const git = args => { const result = spawnSync('git', args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr || 'Cannot read trusted budget base'); return result.stdout; };
  const revision = git(['rev-parse', '--verify', '--end-of-options', values['base-ref'] + '^{commit}']).trim();
  const previous = spawnSync('git', ['show', `${revision}:${POLICY_FILE}`], { encoding: 'utf8' });
  const changed = git(['diff', '--name-only', '-z', revision, '--']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const revisionFiles = [...new Set([...changed, ...untracked])].filter(file => /^docs\/performance\/budget-revisions\/[A-Za-z0-9_-]+\.json$/.test(file) && existsSync(file));
  const revisions = revisionFiles.flatMap(file => {
    const rows = JSON.parse(readFileSync(file, 'utf8')); assert.equal(rows.schema, 1);
    const original = spawnSync('git', ['show', `${revision}:${file}`], { encoding: 'utf8' });
    const prior = original.status === 0 ? JSON.parse(original.stdout) : { schema: 1, revisions: [] };
    assert.equal(prior.schema, 1);
    return currentBudgetRevisions(rows.revisions, prior.revisions);
  });
  if (previous.status === 0) validateBudgetChanges(policy, JSON.parse(previous.stdout), revisions);
  else assert.equal(revision, INTRODUCTION_BASE, 'Missing base budget is allowed only at its introduction commit');
  const collection = JSON.parse(readFileSync('.scratch/verify/collection.json', 'utf8'));
  for (const profile of Object.values(policy.apiProfiles)) {
    assert.ok(collection.nodeids.includes(profile.test), 'Uncollected API performance profile');
    const row = workbenches.find(row => row.id === profile.module), file = profile.test.split('::')[0].replace('tests/', '');
    assert.ok(row.apiPatterns.some(pattern => new RegExp('^' + pattern.replaceAll('.', '\\.').replaceAll('*', '.*') + '$').test(file)), `${row.id}: performance test is outside module verification scope`);
  }
  const dist = path.resolve(values.dist), manifest = JSON.parse(readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'));
  const emitted = readdirSync(dist, { recursive: true }).map(file => file.replaceAll('\\', '/')).filter(file => /\.(js|css)$/.test(file));
  const metrics = bundleMetrics(manifest, file => readFileSync(path.join(dist, file)), workbenches, emitted);
  mkdirSync(path.dirname(values.output), { recursive: true });
  writeFileSync(values.output, JSON.stringify({ schema: 1, kind: 'bundle', base: revision, metrics }, null, 2) + '\n');
  enforceMetrics(metrics, policy, 'bundle.');
  console.log('PASS production bundle budgets ' + JSON.stringify(metrics));
} catch (error) { console.error(error.message); process.exitCode = 1; }
