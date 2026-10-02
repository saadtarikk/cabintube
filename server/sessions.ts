import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Viewer = { expiresAt: number; unlocked?: boolean; accessToken?: string; refreshToken?: string; tokenExpiresAt?: number; pending?: { deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number; interval: number; nextPoll: number; polling?: boolean } };
export type SessionStorage = { file: string; key: string };
export async function sessionStore(storage?: SessionStorage) {
  const viewers = new Map<string, Viewer>();
  const key = storage ? Buffer.from(storage.key, 'base64') : undefined;
  if (key && key.length !== 32) throw new Error('SESSION_KEY must be a base64-encoded 32-byte key.');
  if (storage) {
    try {
      const encrypted = await readFile(storage.file);
      const decipher = createDecipheriv('aes-256-gcm', key!, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const entries = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString()) as [string, Viewer][];
      for (const [id, viewer] of entries) if (/^[\w-]{32}$/.test(id) && viewer.expiresAt > Date.now()) viewers.set(id, viewer);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read encrypted sessions. Check the storage file and SESSION_KEY.'); }
  }
  let queue = Promise.resolve();
  function save() {
    if (!storage) return Promise.resolve();
    // Pending device codes intentionally do not survive a restart.
    const entries = [...viewers].filter(([, v]) => v.expiresAt > Date.now() && (v.unlocked || v.accessToken || v.refreshToken)).map(([id, { pending: _pending, ...v }]) => [id, v]);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key!, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    queue = queue.catch(() => {}).then(async () => {
      await mkdir(dirname(storage.file), { recursive: true, mode: 0o700 });
      await writeFile(storage.file + '.tmp', encrypted, { mode: 0o600 });
      await rename(storage.file + '.tmp', storage.file);
    });
    return queue;
  }
  return { viewers, save };
}
