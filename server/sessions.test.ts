import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionStore } from './sessions.ts';

test('encrypted sessions survive restart, expire, and reject the wrong key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cabintube-sessions-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = { file: join(dir, 'sessions.enc'), key: randomBytes(32).toString('base64') };
  const first = await sessionStore(storage);
  const id = randomBytes(24).toString('base64url');
  first.viewers.set(id, { expiresAt: Date.now() + 60000, unlocked: true, refreshToken: 'private-refresh-token', pending: { deviceCode: 'not-persisted', userCode: 'CODE', verificationUrl: 'https://www.google.com/device', expiresAt: Date.now()+1000, interval: 5, nextPoll: 0 } });
  first.viewers.set(randomBytes(24).toString('base64url'), { expiresAt: Date.now()-1, unlocked: true });
  await first.save();
  assert.equal((await readFile(storage.file)).includes(Buffer.from('private-refresh-token')), false);
  const second = await sessionStore(storage);
  assert.equal(second.viewers.size, 1); assert.equal(second.viewers.get(id)?.refreshToken, 'private-refresh-token'); assert.equal(second.viewers.get(id)?.pending, undefined);
  await assert.rejects(sessionStore({ ...storage, key: randomBytes(32).toString('base64') }), /Unable to read/);
  delete second.viewers.get(id)!.refreshToken; await second.save();
  assert.equal((await sessionStore(storage)).viewers.get(id)?.refreshToken, undefined);
});
