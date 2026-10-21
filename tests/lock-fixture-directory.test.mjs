import assert from 'node:assert/strict';
import { stat, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLockFixtureDirectory, operationLockPort } from './lock-fixture-directory.mjs';

test('fixture allocation rejects an occupied registry or file lock scope before creating real stores', async t => {
  const occupied = createServer(socket => socket.destroy());
  let blockedScope;
  for (let attempt = 0; attempt < 32; attempt++) {
    const scope = `synthetic-fixture-lock:${process.pid}:${attempt}`;
    try {
      await new Promise((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen({ host: '127.0.0.1', port: operationLockPort(scope), exclusive: true }, resolve);
      });
      blockedScope = scope;
      break;
    } catch (error) {
      occupied.removeAllListeners('error');
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  assert.ok(blockedScope, 'Could not allocate the synthetic blocker');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const candidates = [];
  const directory = await createLockFixtureDirectory(join(tmpdir(), 'bailinghub-lock-fixture-test-'), candidate => {
    candidates.push(candidate);
    return candidates.length === 1
      ? [`registry:${candidate}/registry.json`, blockedScope]
      : [`registry:${candidate}/registry.json`, `file:${candidate}/synthetic.json`];
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(candidates.length >= 2);
  await assert.rejects(stat(candidates[0]), { code: 'ENOENT' });
  assert.equal((await stat(directory)).isDirectory(), true);
  // The blocker remains live: allocation avoids it rather than ignoring it.
  assert.equal(occupied.listening, true);
});
