import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.ts';
import type { ResolvedMedia } from './media.ts';

const origin = 'http://127.0.0.1:4317';
const host = '127.0.0.1:4318';

test('unconfigured connection reports honestly; rejects cross-origin requests', async t => {
  const app = await createApp({ origin }); t.after(() => app.close());
  const status = await app.inject({ url: '/api/status', headers: { host } });
  assert.deepEqual(status.json(), { connected: false, configured: false });
  const cookie = status.cookies[0].value;
  const denied = await app.inject({ method: 'POST', url: '/api/youtube/connect', headers: { host, origin: 'https://evil.test', cookie: `cabintube=${cookie}` }, payload: {} });
  assert.equal(denied.statusCode, 403);
  const unconfigured = await app.inject({ method: 'POST', url: '/api/youtube/connect', headers: { host, origin, cookie: `cabintube=${cookie}` }, payload: {} });
  assert.equal(unconfigured.statusCode, 503);
  assert.equal((await app.inject({ url: '/api/status', headers: { host: 'evil.test' } })).statusCode, 403);
});

test('device flow keeps credentials on server, enforces polling, and isolates playback by viewer', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let tokenCalls = 0; let mediaRange = '';
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/device/code')) {
      assert.match(String(init?.body), /youtube.readonly/);
      return Response.json({ device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 });
    }
    if (url.endsWith('/token')) { tokenCalls++; return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }); }
    if (url.includes('googlevideo.com')) { mediaRange = new Headers(init?.headers).get('range') || ''; return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/9', 'content-length': '3' } }); }
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected provider request');
  }) as typeof fetch;
  const media: ResolvedMedia = { title: 'Test', videoId: 'aqz-KE-bpKQ', duration: 10, qualities: [{ height: 720, video: { url: 'https://rr1.googlevideo.com/v?secret=upstream', userAgent: 'test' } }], audio: { url: 'https://rr1.googlevideo.com/a', userAgent: 'test' }, expiresAt: now + 60_000 };
  const app = await createApp({ origin, clientId: 'own-client', clientSecret: 'own-secret', fetcher: fake, resolver: async () => media }); t.after(() => app.close());
  const first = await app.inject({ url: '/api/status', headers: { host } });
  const headers = { host, origin, cookie: `cabintube=${first.cookies[0].value}` };
  const pair = await app.inject({ method: 'POST', url: '/api/youtube/connect', headers, payload: {} });
  assert.equal(pair.statusCode, 200); assert.ok(pair.json().qr.startsWith('data:image/png')); assert.ok(!pair.body.includes('device-secret'));
  assert.equal((await app.inject({ url: '/api/youtube/connect/status', headers })).json().status, 'pending'); assert.equal(tokenCalls, 0);
  now += 5100;
  const linked = await app.inject({ url: '/api/youtube/connect/status', headers });
  assert.equal(linked.json().status, 'connected'); assert.equal(tokenCalls, 1); assert.ok(!linked.body.includes('access-secret'));
  const created = await app.inject({ method: 'POST', url: '/api/playback', headers, payload: { url: 'aqz-KE-bpKQ' } });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  const status = await app.inject({ url: `/api/playback/${id}`, headers });
  assert.equal(status.json().state, 'ready'); assert.ok(!status.body.includes('googlevideo')); assert.ok(!status.body.includes('upstream'));
  const other = await app.inject({ url: '/api/status', headers: { host } });
  const foreign = { host, origin, cookie: `cabintube=${other.cookies[0].value}` };
  assert.equal((await app.inject({ url: `/api/playback/${id}`, headers: foreign })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/playback/${id}/media/720`, headers: foreign })).statusCode, 404);
  const chunk = await app.inject({ url: `/api/playback/${id}/media/720`, headers: { ...headers, range: 'bytes=0-2' } });
  assert.equal(chunk.statusCode, 206); assert.equal(chunk.headers['content-range'], 'bytes 0-2/9'); assert.equal(mediaRange, 'bytes=0-2');
  await app.inject({ method: 'DELETE', url: '/api/youtube/connect', headers });
  assert.equal((await app.inject({ url: `/api/playback/${id}`, headers })).statusCode, 404);
});

test('device authorization handles slow_down and explicit denial', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now); let calls = 0;
  const fake = (async (url: string) => url.endsWith('/device/code')
    ? Response.json({ device_code: 'secret', user_code: 'ABCD', verification_url: 'https://www.google.com/device', expires_in: 30, interval: 5 })
    : Response.json({ error: ++calls === 1 ? 'slow_down' : 'access_denied' }, { status: 400 })) as typeof fetch;
  const app = await createApp({ origin, clientId: 'client', clientSecret: 'secret', fetcher: fake }); t.after(() => app.close());
  const s = await app.inject({ url: '/api/status', headers: { host } }); const headers = { host, origin, cookie: `cabintube=${s.cookies[0].value}` };
  await app.inject({ method: 'POST', url: '/api/youtube/connect', headers, payload: {} }); now += 5001;
  assert.equal((await app.inject({ url: '/api/youtube/connect/status', headers })).json().interval, 10);
  now += 5000; await app.inject({ url: '/api/youtube/connect/status', headers }); assert.equal(calls, 1);
  now += 5001; assert.equal((await app.inject({ url: '/api/youtube/connect/status', headers })).json().status, 'denied');
});

test('browser API helper can cancel a connection without an empty JSON body error', async t => {
  const { api } = await import('../src/api.ts');
  const app = await createApp({ origin }); t.after(() => app.close());
  const first = await app.inject({ url: '/api/status', headers: { host } });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const response = await app.inject({ method: init.method as 'DELETE', url, headers: { ...Object.fromEntries(new Headers(init.headers)), host, origin, cookie: `cabintube=${first.cookies[0].value}` } });
    return new Response(response.body, { status: response.statusCode });
  });
  assert.deepEqual(await api('/youtube/connect/pending', { method: 'DELETE' }), { ok: true });
});

test('public deployment requires the personal code before starting Google authorization', async t => {
  const { createHash } = await import('node:crypto');
  const app = await createApp({ origin, accessCodeHash: createHash('sha256').update('test-access-code').digest('hex') }); t.after(() => app.close());
  const first = await app.inject({ url: '/api/status', headers: { host } });
  assert.equal(first.json().locked, true);
  const headers = { host, origin, cookie: `cabintube=${first.cookies[0].value}` };
  assert.equal((await app.inject({ method: 'POST', url: '/api/youtube/connect', headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/unlock', headers, payload: { code: 'wrong' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/unlock', headers, payload: { code: 'test-access-code' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers })).json().locked, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/youtube/connect', headers })).statusCode, 503);
});

test('a connected browser stays connected after an API restart', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { randomBytes } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'cabintube-api-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const fetcher = (async (input: string) => input.endsWith('/device/code') ? Response.json({ device_code: 'private-device', user_code: 'CODE', verification_url: 'https://www.google.com/device', expires_in: 60, interval: 5 }) : Response.json({ access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600 })) as typeof fetch;
  const config = { origin, clientId: 'test', clientSecret: 'test', fetcher, storage: { file: join(dir, 'sessions.enc'), key: randomBytes(32).toString('base64') } };
  const first = await createApp(config);
  const status = await first.inject({ url: '/api/status', headers: { host } }); const headers = { host, origin, cookie: `cabintube=${status.cookies[0].value}` };
  await first.inject({ method: 'POST', url: '/api/youtube/connect', headers }); now += 6000;
  assert.equal((await first.inject({ url: '/api/youtube/connect/status', headers })).json().status, 'connected');
  await first.close();
  const second = await createApp(config); t.after(() => second.close());
  assert.equal((await second.inject({ url: '/api/status', headers })).json().connected, true);
});
