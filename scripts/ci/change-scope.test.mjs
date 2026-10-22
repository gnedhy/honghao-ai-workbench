import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, copyOnly, uiOnly } from './change-scope.mjs';

const file = 'src/components/SettingsDialog.tsx';
const before = 'const View=()=> <section><div><strong>库存说明</strong><p>旧文案</p></div><span>{cost}</span></section>;';
test('static copy edits and changelog removal use the short route', () => {
  for (const after of [before.replace('旧文案', '新文案'), before.replace('<div><strong>库存说明</strong><p>旧文案</p></div>', '')]) {
    assert.equal(classify([{ file, before, after }], 'pull_request'), 'copy');
  }
});
test('cost, permissions, handlers, references and dynamic content require full checks', () => {
  for (const [a, b] of [
    [before, before.replace('{cost}', '{cost * 1.13}')],
    ['const x=allowed?<p>文案</p>:null', 'const x=true?<p>文案</p>:null'],
    ['const x=<button onClick={save}>保存</button>', 'const x=<button onClick={remove}>保存</button>'],
    ['const x=<a href="/safe">说明</a>', 'const x=<a href="/other">说明</a>'],
    [before, before.replace('<span>{cost}</span>', '')],
    [before, 'invalid <'],
  ]) assert.equal(copyOnly(file, a, b), false);
});
test('database, dependencies, workflow, tests, unknown paths and mixed changes stay full', () => {
  for (const path of ['api/research.py', 'api/migrations/postgresql/0018.sql', 'uv.lock', 'package.json', 'tests/test_auth.py', 'AGENTS.md', 'src/api.ts']) {
    assert.equal(classify([{ file, before, after: before.replace('旧文案', '新文案') }, { file: path, before: 'a', after: 'b' }], 'pull_request'), 'full');
  }
  assert.equal(copyOnly(file, null, before), false);
  assert.equal(copyOnly(file, before, null), false);
});
test('docs are light; scheduled/manual and empty comparisons are full', () => {
  const changes = [{ file: 'docs/guide.md', before: 'a', after: 'b' }];
  assert.equal(classify(changes, 'push'), 'copy');
  for (const event of ['schedule', 'workflow_dispatch', 'unknown']) assert.equal(classify(changes, event), 'full');
  assert.equal(classify([], 'pull_request'), 'full');
});

test('logos, CSS, static layout and control-plane changes do not require API regression', () => {
  const before = 'import React from "react"; import {Lock} from "lucide-react"; const C=()=> <div className="old"><Lock size={18}/><p>标题</p></div>';
  const after = 'import React from "react"; const C=()=> <div className="new"><img src="/brand-gold.svg" alt=""/></div>';
  assert.equal(uiOnly(file, before, after), true);
  assert.equal(classify([{file, before, after}, {file:'public/brand-gold.svg', before:null, after:'svg'}, {file:'src/styles.css',before:'a',after:'b'}], 'pull_request'), 'ui');
  assert.equal(classify([{file:'.github/workflows/frontend-checks.yml',before:'a',after:'b'}], 'pull_request'), 'checks');
  assert.equal(classify([{file:'.github/workflows/frontend-checks.yml',before:'a',after:'b'}, {file:'api/research.py',before:'a',after:'b'}], 'pull_request'), 'full');
  for (const [a,b] of [['const x=<button disabled={busy}>保存</button>','const x=<button disabled={false}>保存</button>'],['const x=<p>{cost}</p>','const x=<p>{cost*1.13}</p>'],['const x=<button onClick={save}>保存</button>','const x=<button onClick={remove}>保存</button>']]) assert.equal(uiOnly(file,a,b),false);
});
