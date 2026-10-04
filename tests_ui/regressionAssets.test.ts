import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAssetIds, frontendFindings, validateBootstrap } from '../scripts/check-regression-assets.mjs';

const file = 'tests_ui/example.test.ts';
const contract = (ids: string[]) => ({ schema: 1, frontend: [{ file, kind: 'node', ids }], retirements: [] });

test('regression inventory rejects removal hidden by new tests and comment decoys', () => {
  const policy = contract(['critical', 'other']);
  const findings = frontendFindings({ [file]: `test('other',()=>{}); test('new',()=>{}); // test('critical',()=>{});` }, policy);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /critical/);
  assert.deepEqual(extractAssetIds(file, `const text="test('fake',()=>{})"; test('real',()=>{});`, 'node'), ['real']);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'api-execution-receipt-'));
  const collection = path.join(directory, 'collection.json'), junit = path.join(directory, 'api.xml');
  const python = path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const rows = ['tests/test_sample.py::test_critical', 'tests/test_sample.py::test_other'];
  const receipt = (cases: string, skipped = 0, tests = 2) => `<testsuites><testsuite name="pytest" tests="${tests}" errors="0" failures="0" skipped="${skipped}">${cases}</testsuite></testsuites>`;
  const critical = '<testcase classname="tests.test_sample" name="test_critical"/>', other = '<testcase classname="tests.test_sample" name="test_other"/>';
  try {
    writeFileSync(collection, JSON.stringify({ schema: 1, count: 2, nodeids: rows }));
    const validate = (xml: string) => {
      writeFileSync(junit, xml);
      return spawnSync(python, ['scripts/check-api-execution.py', '--collection', collection, '--junit', junit], { encoding: 'utf8' });
    };
    assert.equal(validate(receipt(critical + other)).status, 0);
    assert.match(validate(receipt(other, 0, 1)).stderr, /omitted collected tests/); // -k other is green in pytest, insufficient here.
    assert.match(validate(receipt(critical + critical)).stderr, /duplicated/);
    assert.match(validate(receipt(critical + '<testcase classname="tests.test_sample" name="test_other"><skipped type="pytest.skip"/></testcase>', 1)).stderr, /dynamic skips/);
    assert.match(validate(receipt(critical + '<testcase classname="tests.test_sample" name="test_other"><skipped type="pytest.xfail"/></testcase>', 0)).stderr, /dynamic skip\/xfail/);
    writeFileSync(collection, JSON.stringify({ schema: 1, count: 2, nodeids: ['tests/test_sample.py::test_critical[client::1]', 'tests/test_second.py::test_second'] }));
    writeFileSync(junit, receipt('<testcase classname="tests.test_sample" name="test_critical[client::1]"/>', 0, 1));
    assert.equal(spawnSync(python, ['scripts/check-api-execution.py', '--collection', collection, '--junit', junit, '--files', 'tests/test_sample.py'], { encoding: 'utf8' }).status, 0);
    assert.match(spawnSync(python, ['scripts/check-api-execution.py', '--collection', collection, '--junit', junit], { encoding: 'utf8' }).stderr, /omitted collected tests/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('regression inventory rejects duplicate invalid stale and disabled declarations', () => {
  assert.throws(() => extractAssetIds(file, `test('critical',()=>{}); test('critical',()=>{});`, 'node'), /duplicate/);
  assert.throws(() => extractAssetIds(file, 'test.' + "skip('critical',()=>{});", 'node'), /cannot protect/);
  assert.throws(() => extractAssetIds(file, `test('critical',{skip:true},()=>{});`, 'node'), /disabled/);
  assert.throws(() => extractAssetIds(file, `test('critical');`, 'node'), /callback/);
  assert.throws(() => frontendFindings({ [file]: `test('critical',()=>{});` }, contract(['critical', 'critical'])), /Duplicate/);
  assert.throws(() => frontendFindings({}, contract(['critical'])), /Missing/);
  assert.throws(() => frontendFindings({ [file]: `test('critical',()=>{});` }, contract([])), /Empty/);
});

test('browser scene inventory reads executable AST calls and finite named loops', () => {
  const browser = 'scripts/check-example.mjs';
  assert.deepEqual(extractAssetIds(browser, `// await run('decoy',()=>{});
    for(const kind of ['sales','research']) await scenario('draft-'+kind, '', async()=>{});
    await run('read-retry', '', async()=>{});`, 'browser'), ['draft-sales', 'draft-research', 'read-retry']);
  assert.throws(() => extractAssetIds(browser, `await run(dynamicName,'',async()=>{});`, 'browser'), /statically readable/);
  assert.throws(() => extractAssetIds(browser, `await run('empty','');`, 'browser'), /callback/);
});

test('protection removal needs a review reason and a live protected replacement', () => {
  const before = contract(['critical', 'other']), after = contract(['replacement', 'other']);
  const sources = { [file]: `test('replacement',()=>{}); test('other',()=>{});` };
  assert.match(frontendFindings(sources, after, before).join('\n'), /without retirement/);
  after.retirements.push({ asset: { kind: 'node', file, id: 'critical' }, replacements: [{ kind: 'node', file, id: 'replacement' }], reason: 'Equivalent assertions consolidated into the new named scenario' });
  assert.deepEqual(frontendFindings(sources, after, before), []);
  after.retirements[0].reason = 'ok';
  assert.throws(() => frontendFindings(sources, after, before), /review reason/);
});

test('missing trusted inventory cannot silently bootstrap from any revision or reduced inventory', () => {
  assert.throws(() => validateBootstrap('deadbeef', 140, contract(['critical'])), /pinned/);
  assert.throws(() => validateBootstrap('1c57482eb41f48f5acd6fcd36395d38e84086948', 139, contract(['critical'])), /pinned/);
  assert.throws(() => validateBootstrap('1c57482eb41f48f5acd6fcd36395d38e84086948', 140, contract(['critical'])), /pinned/);
});
