import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAst } from 'rolldown/parseAst';

const contractPath = 'scripts/regression-contract.json';
const bootstrapRevision = '1c57482eb41f48f5acd6fcd36395d38e84086948';
const bootstrapSha256 = 'dd24a4e2fb16d5af416f3f30fa4406c68d043e0fbd0800c5c8ad9d9a84a98146';
export const assetKey = asset => `${asset.kind}:${asset.file ?? ''}::${asset.id}`;

// Extract executable calls, never comments or stringified fixture source.
export function extractAssetIds(file, text, kind) {
  const ids = [];
  const evaluate = (node, env) => {
    if (node?.type === 'Literal') return node.value;
    if (node?.type === 'Identifier') return env[node.name];
    if (node?.type === 'BinaryExpression' && node.operator === '+') {
      const left = evaluate(node.left, env), right = evaluate(node.right, env);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    if (node?.type === 'TemplateLiteral') {
      const values = node.expressions.map(value => evaluate(value, env));
      if (values.some(value => value === undefined)) return undefined;
      return node.quasis.map((part, i) => part.value.cooked + (values[i] ?? '')).join('');
    }
    return undefined;
  };
  function visit(node, env = {}) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ForOfStatement' && node.right.type === 'ArrayExpression') {
      const variable = node.left.declarations?.[0]?.id?.name;
      const values = node.right.elements.map(item => evaluate(item, env));
      if (variable && values.every(value => value !== undefined)) {
        values.forEach(value => visit(node.body, { ...env, [variable]: value }));
        return;
      }
    }
    if (node.type === 'CallExpression') {
      const name = node.callee.name;
      const member = node.callee.type === 'MemberExpression' && node.callee.object.name;
      const matching = kind === 'node' ? name === 'test' || member === 'test' : ['run', 'scenario'].includes(name);
      if (matching && node.arguments[0]?.type !== 'SpreadElement') {
        const id = evaluate(node.arguments[0], env);
        assert.equal(typeof id, 'string', `${file}: regression call name must be statically readable`);
        assert.ok(id.trim(), `${file}: regression ID is empty`);
        if (kind === 'node') {
          assert.ok(!member, `${file}: test.${node.callee.property?.name} cannot protect a regression`);
          assert.ok(node.arguments.some(argument => ['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type)), `${file}: test must have executable callback`);
          const options = node.arguments[1];
          if (options?.type === 'ObjectExpression') {
            for (const property of options.properties) assert.ok(!['skip', 'todo', 'only'].includes(property.key?.name ?? property.key?.value), `${file}: disabled test cannot protect a regression`);
          }
        } else {
          assert.ok(node.arguments.some(argument => ['ArrowFunctionExpression', 'FunctionExpression'].includes(argument.type)), `${file}: browser scenario must have executable callback`);
        }
        ids.push(id);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, env));
      else if (value && typeof value === 'object') visit(value, env);
    }
  }
  visit(parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file));
  assert.equal(ids.length, new Set(ids).size, `${file}: duplicate regression IDs`);
  return ids;
}

export function protectedFrontend(contract) {
  assert.equal(contract.schema, 1, 'Unsupported regression contract schema');
  assert.ok(Array.isArray(contract.frontend) && contract.frontend.length, 'Frontend inventory must not be empty');
  const entries = new Map();
  const groups = new Set();
  for (const row of contract.frontend) {
    assert.ok(['node', 'browser'].includes(row.kind) && typeof row.file === 'string' && !row.file.includes('..') && !path.isAbsolute(row.file), 'Invalid frontend asset');
    assert.ok(row.kind === 'node' ? /^tests_ui\/[^/]+\.test\.ts$/.test(row.file) : /^scripts\/check-[^/]+\.mjs$/.test(row.file), 'Invalid frontend asset location');
    assert.ok(Array.isArray(row.ids) && row.ids.length, `Empty inventory: ${row.file}`);
    const group = `${row.kind}:${row.file}`;
    assert.ok(!groups.has(group), `Duplicate regression inventory group: ${group}`); groups.add(group);
    for (const id of row.ids) {
      assert.ok(typeof id === 'string' && id.trim(), 'Invalid frontend ID');
      const asset = { kind: row.kind, file: row.file, id }, key = assetKey(asset);
      assert.ok(!entries.has(key), `Duplicate protected regression: ${key}`);
      entries.set(key, asset);
    }
  }
  return entries;
}

export function frontendFindings(sources, contract, previous) {
  const current = protectedFrontend(contract), findings = [], actual = new Set();
  for (const row of contract.frontend) {
    assert.ok(Object.hasOwn(sources, row.file), `Missing protected regression file: ${row.file}`);
    extractAssetIds(row.file, sources[row.file], row.kind).forEach(id => actual.add(assetKey({ ...row, id })));
  }
  for (const key of current.keys()) if (!actual.has(key)) findings.push(`Protected regression is missing: ${key}`);
  assert.ok(Array.isArray(contract.retirements), 'Invalid retirements');
  const retired = new Set();
  for (const row of contract.retirements) {
    assert.ok(row.asset && ['api', 'node', 'browser'].includes(row.asset.kind), 'Invalid retired asset');
    if (row.asset.kind === 'api') continue; // Validated by the collected API gate.
    const key = assetKey(row.asset);
    assert.ok(!retired.has(key), `Duplicate retirement: ${key}`); retired.add(key);
    assert.ok(typeof row.reason === 'string' && row.reason.trim().length >= 10, 'Retirement needs a concrete review reason');
    assert.ok(!current.has(key), `Retired asset is still protected: ${key}`);
    assert.ok(Array.isArray(row.replacements) && row.replacements.length, 'Retirement needs protected replacements');
    const keys = row.replacements.map(assetKey);
    assert.ok(new Set(keys).size === keys.length && keys.every(value => current.has(value) && actual.has(value)), 'Retirement replacement is missing or unprotected');
    if (previous) assert.ok(protectedFrontend(previous).has(key) || previous.retirements.some(item => assetKey(item.asset) === key), 'Retirement does not refer to a base asset');
  }
  if (previous) for (const key of protectedFrontend(previous).keys()) if (!current.has(key) && !retired.has(key)) findings.push(`Regression protection removed without retirement: ${key}`);
  return findings;
}

export function validateBootstrap(revision, previousBaseline, contract) {
  const digest = createHash('sha256').update(JSON.stringify([...protectedFrontend(contract).keys()].sort())).digest('hex');
  assert.ok(revision === bootstrapRevision && previousBaseline === 140 && digest === bootstrapSha256, 'Missing base inventory is permitted only for the pinned initial frontend bootstrap');
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { root: { type: 'string', default: process.cwd() }, 'base-ref': { type: 'string' } } });
    const root = path.resolve(values.root), contract = JSON.parse(readFileSync(path.join(root, contractPath), 'utf8'));
    let previous;
    if (values['base-ref']) {
      const result = spawnSync('git', ['show', `${values['base-ref']}:${contractPath}`], { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) {
        const resolved = spawnSync('git', ['rev-parse', '--verify', `${values['base-ref']}^{commit}`], { cwd: root, encoding: 'utf8' });
        const baseline = spawnSync('git', ['show', `${values['base-ref']}:test-count-baseline.txt`], { cwd: root, encoding: 'utf8' });
        assert.equal(resolved.status, 0, 'Cannot resolve trusted base');
        assert.equal(baseline.status, 0, 'Cannot read trusted base floor');
        validateBootstrap(resolved.stdout.trim(), Number(baseline.stdout.trim()), contract);
        console.log(`Frontend regression inventory bootstrap: pinned base ${bootstrapRevision}; original named assets frozen`);
        previous = contract;
      } else previous = JSON.parse(result.stdout);
    }
    const sources = Object.fromEntries(contract.frontend.map(row => [row.file, readFileSync(path.join(root, row.file), 'utf8')]));
    // Detect disabled/duplicate calls in newly added Node suites too, before they are promoted into the fixed inventory.
    for (const file of readdirSync(path.join(root, 'tests_ui')).filter(file => file.endsWith('.test.ts'))) extractAssetIds(`tests_ui/${file}`, readFileSync(path.join(root, 'tests_ui', file), 'utf8'), 'node');
    const findings = frontendFindings(sources, contract, previous);
    assert.equal(findings.length, 0, findings.join('\n'));
    console.log(`Frontend regression assets passed: ${protectedFrontend(contract).size} named assets present (presence check; suites execute assertions and reviewers assess their meaning)`);
    return 0;
  } catch (error) { console.error(`Frontend regression assets failed: ${error.message}`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
