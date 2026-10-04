import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Verifiers share collection and performance receipts even when API scopes differ.
export function acquireVerificationLock(directory, scope) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'run.lock');
  let descriptor;
  try {
    descriptor = openSync(path, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another verifier owns .scratch/verify/run.lock. Run verifiers serially; after an interrupted run, inspect its PID before removing the stale lock.');
    throw error;
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, scope }) + '\n');
  } catch (error) {
    closeSync(descriptor); unlinkSync(path); throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(descriptor); unlinkSync(path);
  };
}
