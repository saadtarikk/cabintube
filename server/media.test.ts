import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoId, isMediaUrl, chooseFormats, fetchMedia } from './media.ts';

test('YouTube inputs accept real video forms and reject arbitrary destinations', () => {
  for (const value of ['aqz-KE-bpKQ', 'https://youtu.be/aqz-KE-bpKQ?t=10', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtube.com/shorts/aqz-KE-bpKQ']) assert.equal(videoId(value), 'aqz-KE-bpKQ');
  for (const value of ['https://evil.test/watch?v=aqz-KE-bpKQ', 'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ', 'file:///etc/passwd', 'https://user:password@youtube.com/watch?v=aqz-KE-bpKQ', '--exec=bad', 'https://youtube.com/playlist?list=abc']) assert.throws(() => videoId(value));
  assert.equal(isMediaUrl('https://rr1---sn.example.googlevideo.com/videoplayback'), true);
  for (const value of ['http://rr1.googlevideo.com/a', 'https://googlevideo.com.evil.test/a', 'https://127.0.0.1/a', 'https://rr1.googlevideo.com:8443/a']) assert.equal(isMediaUrl(value), false);
});

test('resolver chooses compatible video qualities and independent AAC audio', () => {
  const f = (height: number, vcodec = 'avc1.640020') => ({ url: `https://rr1.googlevideo.com/videoplayback?itag=${height}`, protocol: 'https', vcodec, acodec: 'none', height, fps: 30 });
  const result = chooseFormats({ title: 'Sample', duration: 30, formats: [f(1080), f(720), f(480), f(360), f(720, 'av01'), { url: 'https://rr1.googlevideo.com/audio', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }] }, 'aqz-KE-bpKQ');
  assert.deepEqual(result.qualities.map(q => q.height), [720, 480, 360]);
  assert.equal(result.audio.url, 'https://rr1.googlevideo.com/audio');
  assert.throws(() => chooseFormats({ is_live: true }, 'aqz-KE-bpKQ'), /Live streams/);
  assert.throws(() => chooseFormats({ formats: [f(720)] }, 'aqz-KE-bpKQ'), /compatible/);
});

test('media proxy refuses unsafe redirects and malformed ranges', async () => {
  const calls: string[] = [];
  const fake = (async (url: string) => { calls.push(url); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); }) as typeof fetch;
  const track = { url: 'https://rr1.googlevideo.com/media', userAgent: 'test' };
  await assert.rejects(fetchMedia(track, 'bytes=0-99', new AbortController().signal, fake), /Invalid media destination/);
  assert.equal(calls.length, 1);
  await assert.rejects(fetchMedia(track, 'bytes=0-10,20-30', new AbortController().signal, fake), /Unsupported byte range/);
  await assert.rejects(fetchMedia(track, 'bytes=-', new AbortController().signal, fake), /Unsupported byte range/);
});

test('open-ended browser ranges and full requests stream bounded chunks without gaps', async () => {
  const size = 2 * 1024 * 1024 + 43;
  const data = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const requests: string[] = [];
  const fake = (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')!; requests.push(range);
    const m = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response(null, { status: 403 });
    const start = Number(m[1]), end = Math.min(Number(m[2]), size - 1);
    assert.ok(end - start + 1 <= 2 * 1024 * 1024);
    if (start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(data.slice(start, end + 1), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${size}` } });
  }) as typeof fetch;
  const track = { url: 'https://rr1.googlevideo.com/media', userAgent: 'test' };
  for (const range of ['bytes=0-', 'bytes=17-2097160', 'bytes=-12', undefined]) {
    requests.length = 0;
    const response = await fetchMedia(track, range, new AbortController().signal, fake);
    const body = new Uint8Array(await response.arrayBuffer());
    const expected = range === 'bytes=-12' ? data.slice(-12) : range === 'bytes=17-2097160' ? data.slice(17, 2097161) : data;
    assert.deepEqual(body, expected);
    assert.equal(response.status, range ? 206 : 200);
    assert.equal(Number(response.headers.get('content-length')), expected.length);
    if (range === 'bytes=0-') assert.ok(requests.length > 1);
    if (!range) assert.equal(response.headers.get('content-range'), null);
  }
  assert.equal((await fetchMedia(track, `bytes=${size}-`, new AbortController().signal, fake)).status, 416);
  for (const range of ['bytes=3-2', 'bytes=-0', 'bytes=9007199254740992-']) await assert.rejects(fetchMedia(track, range, new AbortController().signal, fake), /Unsupported byte range/);
});

test('cancelling a media response stops further chunk downloads', async () => {
  let requests = 0;
  const fake = (async () => {
    requests++;
    return new Response(new Uint8Array(1024), { status: 206, headers: { 'content-range': 'bytes 0-1023/4096' } });
  }) as typeof fetch;
  const response = await fetchMedia({ url: 'https://rr1.googlevideo.com/media', userAgent: 'test' }, 'bytes=0-', new AbortController().signal, fake);
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  assert.equal(requests, 1);
});

test('audio selection prefers the original language over a higher-bitrate dub', () => {
  const result = chooseFormats({ formats: [
    { url: 'https://rr1.googlevideo.com/video', protocol: 'https', vcodec: 'avc1', acodec: 'none', height: 720 },
    { url: 'https://rr1.googlevideo.com/dub', protocol: 'https', vcodec: 'none', acodec: 'mp4a', language_preference: -1, abr: 160 },
    { url: 'https://rr1.googlevideo.com/original', protocol: 'https', vcodec: 'none', acodec: 'mp4a', language_preference: 10, abr: 128 },
  ] }, 'aqz-KE-bpKQ');
  assert.equal(result.audio.url, 'https://rr1.googlevideo.com/original');
});

test('relay detects truncated chunks and refuses servers ignoring ranges', async () => {
  const track = { url: 'https://rr1.googlevideo.com/media', userAgent: 'test' };
  const truncated = (async () => new Response(new Uint8Array(2), { status: 206, headers: { 'content-range': 'bytes 0-3/4' } })) as typeof fetch;
  const response = await fetchMedia(track, 'bytes=0-', new AbortController().signal, truncated);
  await assert.rejects(response.arrayBuffer(), /ended before/);
  const ignored = (async () => new Response(new Uint8Array(4), { status: 200 })) as typeof fetch;
  for (const range of ['bytes=0-', 'bytes=-2']) await assert.rejects(fetchMedia(track, range, new AbortController().signal, ignored), /does not support byte ranges/);
});

test('stream sessions use upstream expiry instead of the former twenty minute cutoff', () => {
  const expiry = Math.floor(Date.now()/1000) + 6*3600;
  const result = chooseFormats({ formats: [
    { url: `https://rr1.googlevideo.com/video?expire=${expiry}`, protocol: 'https', vcodec: 'avc1', acodec: 'none', height: 720 },
    { url: `https://rr1.googlevideo.com/audio?expire=${expiry}`, protocol: 'https', vcodec: 'none', acodec: 'mp4a' },
  ] }, 'aqz-KE-bpKQ');
  assert.equal(result.expiresAt, expiry * 1000 - 60000);
});
