import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireVerificationLock } from '../scripts/verification-lock.mjs';

test('concurrent verifier cannot overwrite receipts and lock releases for the next process', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verification-lock-'));
  const module = new URL('../scripts/verification-lock.mjs', import.meta.url).href;
  const attempt = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireVerificationLock } from ${JSON.stringify(module)}; const release=acquireVerificationLock(process.argv[1], 'frontend'); release();`, directory], { encoding: 'utf8' });
  const release = acquireVerificationLock(directory, 'all');
  try {
    const owner = readFileSync(join(directory, 'run.lock'), 'utf8');
    const denied = attempt();
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Another verifier owns/);
    assert.equal(readFileSync(join(directory, 'run.lock'), 'utf8'), owner);
    release();
    assert.equal(attempt().status, 0);
  } finally {
    release();
    assert.ok(directory.startsWith(join(tmpdir(), 'verification-lock-')), 'Cleanup stays in this test temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
});
