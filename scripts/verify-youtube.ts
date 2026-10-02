import { resolveMedia, fetchMedia } from '../server/media.ts';

try {
  // Public Blender sample; resolve metadata and small initialization ranges only.
  const start = Date.now();
  const media = await resolveMedia('aqz-KE-bpKQ', AbortSignal.timeout(65_000));
  console.log(JSON.stringify({ resolved: true, elapsedMs: Date.now() - start, qualities: media.qualities.map(q => q.height), duration: media.duration }));
  for (const [name, track] of [['video', media.qualities[0].video], ['audio', media.audio]] as const) {
    const response = await fetchMedia(track, 'bytes=0-1023', AbortSignal.timeout(20_000));
    const bytes = await response.arrayBuffer();
    console.log(JSON.stringify({ track: name, status: response.status, type: response.headers.get('content-type'), bytes: bytes.byteLength }));
    if (response.status !== 206 || bytes.byteLength !== 1024) process.exitCode = 1;
  }
} catch (e) { console.log(JSON.stringify({ resolved: false, error: (e as Error).message })); process.exitCode = 1; }
