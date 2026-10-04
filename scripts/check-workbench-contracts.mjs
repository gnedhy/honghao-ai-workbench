import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parseAst } from 'rolldown/parseAst';
import { walk } from './check-frontend-quality.mjs';
import { extractAssetIds } from './check-regression-assets.mjs';

const text = file => readFileSync(file, 'utf8');
const unwrap = node => node?.type === 'TSAsExpression' || node?.type === 'TSSatisfiesExpression' ? unwrap(node.expression) : node;
const key = node => node?.name ?? node?.value;
const unique = (values, label) => {
  assert.ok(Array.isArray(values) && values.every(value => typeof value === 'string' && value.trim()), `${label}: expected nonempty strings`);
  assert.equal(new Set(values).size, values.length, `${label}: duplicate entry`);
  return values;
};
const same = (actual, expected, label) => assert.deepEqual([...unique(actual, label)].sort(), [...unique(expected, label)].sort(), label);
const safePath = file => assert.ok(typeof file === 'string' && file && !path.posix.isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..'), `Invalid repository path: ${file}`);
export function frontendInventory(sources) {
  const types = {}, variables = {};
  for (const file of ['src/types.ts', 'src/workbenchRegistry.ts']) {
    walk(parseAst(sources[file], { lang: 'ts' }, file), node => {
      if (node.type === 'TSTypeAliasDeclaration') types[node.id.name] = node.typeAnnotation;
      if (node.type === 'VariableDeclarator') variables[node.id.name] = unwrap(node.init);
    });
  }
  const literalUnion = name => {
    const node = types[name];
    assert.ok(node, `Missing page/workbench type: ${name}`);
    const items = node.type === 'TSUnionType' ? node.types : [node];
    assert.ok(items.every(item => item.type === 'TSLiteralType' && typeof item.literal.value === 'string'), `Nonliteral type: ${name}`);
    return items.map(item => item.literal.value);
  };
  const properties = name => {
    assert.equal(variables[name]?.type, 'ObjectExpression', `Missing static object: ${name}`);
    return variables[name].properties;
  };
  assert.equal(variables.workbenches?.type, 'ArrayExpression', 'Missing static workbench registry');
  const registry = variables.workbenches.elements.map(item => {
    assert.equal(item?.type, 'ObjectExpression', 'Workbench metadata must be static');
    const property = item.properties.find(row => key(row.key) === 'id');
    assert.equal(property?.value?.type, 'Literal', 'Workbench ID must be a literal');
    return property.value.value;
  });
  const navigation = Object.fromEntries(properties('workbenchPages').map(row => {
    assert.equal(row.value.type, 'ArrayExpression', 'Navigation must be static');
    return [key(row.key), row.value.elements.map(item => item.properties.find(p => key(p.key) === 'id')?.value?.value)];
  }));
  const labels = Object.fromEntries(properties('workbenchLabels').map(row => [key(row.key), row.value.value]));
  const slotIds = [], entries = [];
  walk(parseAst(sources['src/workbenches/WorkbenchModuleSlot.tsx'], { lang: 'tsx' }), node => {
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') entries.push(path.posix.normalize('src/workbenches/' + node.source.value) + '.tsx');
    if (node.type === 'BinaryExpression' && node.operator === '===' && node.left.type === 'MemberExpression' && key(node.left.property) === 'workbenchId' && typeof node.right.value === 'string') slotIds.push(node.right.value);
  });
  return { ids: literalUnion('WorkbenchId'), registry, navigation, labels, literalUnion, variables, slotIds, entries };
}

export function validateContracts(contract, sources, backend, nodeids, fileExists = existsSync, boundaries) {
  assert.equal(contract.schema, 1, 'Unknown workbench contract schema');
  assert.ok(Array.isArray(contract.workbenches) && contract.workbenches.length, 'Missing workbench contracts');
  const front = frontendInventory(sources), ids = contract.workbenches.map(row => row.id);
  same(front.ids, ids, 'Type/contract workbenches');
  same(front.registry, ids, 'Registry/contract workbenches');
  same(Object.keys(front.labels), ids, 'Settings labels/contract workbenches');
  for (const field of ['workbenches', 'typeIds', 'scopes']) same(backend[field], ids, `Backend ${field}/contract workbenches`);
  const implemented = contract.workbenches.filter(row => row.entry !== null);
  if (boundaries) same(boundaries.entries, implemented.map(row => row.entry), 'Quality boundary/contract entries');
  same(front.entries, implemented.map(row => row.entry), 'Lazy entry/contract workbenches');
  same(front.slotIds, implemented.map(row => row.id), 'Slot adapter/contract workbenches');
  same(Object.keys(front.navigation), implemented.map(row => row.id), 'Navigation/contract workbenches');
  for (const row of contract.workbenches) {
    for (const field of ['owner', 'permissions', 'data', 'lifecycle', 'exits', 'compatibility', 'recovery']) assert.ok(typeof row[field] === 'string' && row[field].trim(), `${row.id}: missing ${field}`);
    unique(row.apiPatterns, `${row.id}: apiPatterns`);
    assert.ok(row.apiPatterns.every(pattern => /^test_[A-Za-z0-9_*]+\.py$/.test(pattern)), `${row.id}: unsafe API pattern`);
    assert.ok(row.apiPatterns.length, `${row.id}: API scope is empty`);
    for (const file of row.consumers) { safePath(file); assert.ok(fileExists(file), `${row.id}: missing consumer ${file}`); }
    assert.ok(row.consumers.length, `${row.id}: consumers are empty`);
    unique(row.apiTests, `${row.id}: apiTests`);
    assert.ok(row.apiTests.length && row.apiTests.every(id => nodeids.includes(id)), `${row.id}: uncollected API regression`);
    if (row.entry !== null) {
      const files = [...new Set(nodeids.map(id => id.split('::')[0].replace(/^tests\//, '')))];
      const selected = scopeFiles(contract, row.id, files);
      assert.ok([...row.apiTests, ...row.browserTests.map(test => test.apiTest)].every(id => selected.includes(id.split('::')[0])), `${row.id}: API/browser regression is outside declared scope`);
    }
    for (const test of row.browserTests) {
      validateFrontendTest(test, sources, 'browser');
      assert.ok(nodeids.includes(test.apiTest) && backend.browserWrappers[test.file]?.includes(test.apiTest), `${row.id}: browser test is not connected to an API wrapper`);
    }
    if (row.entry === null) {
      assert.equal(row.pageType, null, `${row.id}: unimplemented module has page type`);
      same(row.pages, [], `${row.id}: unimplemented module pages`);
      assert.equal(row.status, 'unimplemented', `${row.id}: placeholder status`);
    } else {
      safePath(row.entry); assert.ok(fileExists(row.entry), `${row.id}: missing entry`);
      assert.equal(path.posix.basename(row.entry).toLowerCase(), `${row.id}workbench.tsx`, `${row.id}: entry name must identify its module boundary`);
      assert.equal(row.status, 'implemented', `${row.id}: entry status`);
      same(front.literalUnion(row.pageType), row.pages, `${row.id}: page type/contract`);
      const pageLabels = unwrap(front.variables[row.pageLabels]);
      assert.equal(pageLabels?.type, 'ObjectExpression', `${row.id}: missing page labels`);
      same(pageLabels.properties.map(p => key(p.key)), row.pages, `${row.id}: page labels/contract`);
      unique(front.navigation[row.id], `${row.id}: navigation`);
      assert.ok(front.navigation[row.id].every(page => row.pages.includes(page)), `${row.id}: unknown navigation page`);
      assert.ok(row.browserTests.length, `${row.id}: no actual browser regression`);
    }
  }
  return front;
}

function validateFrontendTest(test, sources, kind) {
  safePath(test.file);
  if (kind === 'node') assert.match(test.file, /^tests_ui\/[^/]+\.test\.ts$/, 'Node regression is not collected by the unified gate');
  assert.ok(typeof test.id === 'string' && test.id.trim(), 'Missing frontend test ID');
  assert.ok(sources[test.file] && extractAssetIds(test.file, sources[test.file], kind).includes(test.id), `Missing ${kind} regression: ${test.file} :: ${test.id}`);
}

export const productFile = file => /^src\/.*\.(?:ts|tsx|css)$/.test(file) || /^api\/.*\.(?:py|sql)$/.test(file) && !['api/test_count_gate.py', 'api/security_gate.py'].includes(file);
export function validateChanges(changed, declarations, contract, sources, nodeids, browserWrappers = {}) {
  const product = changed.filter(productFile), covered = new Set();
  for (const [file, declaration] of Object.entries(declarations)) {
    assert.equal(declaration.schema, 1, `${file}: unknown change schema`);
    assert.ok(['presentation', 'business'].includes(declaration.kind), `${file}: unknown change kind`);
    for (const field of ['summary', 'permissions', 'data', 'lifecycle', 'exits', 'compatibility', 'recovery']) assert.ok(typeof declaration[field] === 'string' && declaration[field].trim(), `${file}: missing ${field}`);
    unique(declaration.modules, `${file}: modules`);
    assert.ok(declaration.modules.length && declaration.modules.every(id => contract.workbenches.some(row => row.id === id)), `${file}: unknown module`);
    unique(declaration.files, `${file}: files`);
    assert.ok(declaration.files.length, `${file}: files are empty`);
    for (const item of declaration.files) { safePath(item); assert.ok(product.includes(item), `${file}: file is not in this product diff: ${item}`); covered.add(item); }
    assert.ok(Array.isArray(declaration.consumers) && declaration.consumers.length, `${file}: consumers are empty`);
    for (const consumer of declaration.consumers) { safePath(consumer); assert.ok(Object.hasOwn(sources, consumer), `${file}: missing consumer ${consumer}`); }
    const verification = declaration.verification;
    assert.ok(verification && Array.isArray(verification.api) && Array.isArray(verification.node) && Array.isArray(verification.browser), `${file}: incomplete verification`);
    unique(verification.api, `${file}: api tests`);
    assert.ok(verification.api.every(id => nodeids.includes(id)), `${file}: uncollected API test`);
    for (const test of verification.node) validateFrontendTest(test, sources, 'node');
    for (const test of verification.browser) validateFrontendTest(test, sources, 'browser');
    assert.ok(verification.api.length + verification.node.length + verification.browser.length, `${file}: no regression`);
    if (declaration.kind === 'business') {
      assert.ok(verification.api.length && verification.browser.length, `${file}: business change needs API and actual browser regression`);
      for (const test of verification.browser) assert.ok(verification.api.includes(test.apiTest) && browserWrappers[test.file]?.includes(test.apiTest), `${file}: browser regression is not connected to an executed API wrapper`);
    }
  }
  assert.ok(product.every(file => covered.has(file)), `Missing current change declaration: ${product.filter(file => !covered.has(file)).join(', ')}`);
}

export function scopeFiles(contract, scope, files) {
  if (scope === 'all') return [];
  if (scope === 'frontend') return null;
  const row = contract.workbenches.find(item => item.id === scope && item.entry !== null);
  assert.ok(row, `Unknown verification scope: ${scope}`);
  const patterns = row.apiPatterns.map(pattern => new RegExp('^' + pattern.replaceAll('.', '\\.').replaceAll('*', '.*') + '$'));
  const selected = files.filter(file => patterns.some(pattern => pattern.test(file))).sort().map(file => 'tests/' + file);
  assert.ok(selected.length, `${scope}: API scope selected no files`);
  return selected;
}

function main() {
  const { values } = parseArgs({ options: { 'base-ref': { type: 'string' }, collection: { type: 'string', default: '.scratch/verify/collection.json' } } });
  const contract = JSON.parse(text('scripts/workbench-contracts.json'));
  const sources = Object.fromEntries(['src', 'api', 'scripts', 'tests_ui'].flatMap(folder => readdirSync(folder, { recursive: true }).filter(file => /\.(?:ts|tsx|mjs|py|sql|css)$/.test(file)).map(file => [folder + '/' + file.replaceAll('\\', '/'), text(folder + '/' + file)])));
  const result = spawnSync('uv', ['run', '--locked', 'python', 'scripts/workbench-inventory.py'], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(result.status, 0, result.stderr || 'Backend inventory failed');
  const collection = JSON.parse(text(values.collection));
  assert.equal(collection.schema, 1, 'Invalid API collection schema');
  const backend = JSON.parse(result.stdout);
  validateContracts(contract, sources, backend, collection.nodeids, existsSync, JSON.parse(text('scripts/frontend-boundaries.json')));
  if (values['base-ref']) {
    const git = args => { const result = spawnSync('git', args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
    git(['rev-parse', '--verify', '--end-of-options', values['base-ref'] + '^{commit}']);
    const changed = git(['diff', '--name-only', '-z', values['base-ref'], '--']).split('\0').filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const all = [...new Set([...changed, ...untracked])];
    const declarations = Object.fromEntries(all.filter(file => /^docs\/changes\/[^/]+\.json$/.test(file) && existsSync(file)).map(file => [file, JSON.parse(text(file))]));
    validateChanges(all, declarations, contract, sources, collection.nodeids, backend.browserWrappers);
    console.log(`PASS extension change declarations against ${values['base-ref']}`);
  }
  console.log(`PASS extension contracts: ${contract.workbenches.length} workbenches; backend/type/registry/lazy/navigation/tests agree`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
