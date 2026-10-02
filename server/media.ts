import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export class PublicError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export function videoId(input: string): string {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let u: URL;
  try { u = new URL(text); } catch { throw new PublicError('Paste a valid YouTube video link.'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) throw new PublicError('Paste a valid YouTube video link.');
  const host = u.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    id = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(shorts|live|embed)\//.test(u.pathname) ? u.pathname.split('/')[2] : null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) throw new PublicError('Use a YouTube video link, rather than a playlist or channel.');
  return id;
}
export function isMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.endsWith('.googlevideo.com') && !u.port && !u.username && !u.password;
  } catch { return false; }
}
type Format = { url?: string; protocol?: string; vcodec?: string; acodec?: string; height?: number; width?: number; fps?: number; language_preference?: number; abr?: number; tbr?: number; ext?: string; http_headers?: Record<string, string> };
export type Track = { url: string; userAgent: string };
export type ResolvedMedia = { title: string; duration: number; videoId: string; qualities: { height: number; video: Track }[]; audio: Track; expiresAt: number };

export function chooseFormats(info: { formats?: Format[]; title?: string; duration?: number; is_live?: boolean }, id: string): ResolvedMedia {
  if (info.is_live) throw new PublicError('Live streams are not supported in this first version.', 422);
  const safe = (info.formats || []).filter(f => f.url && isMediaUrl(f.url) && f.protocol === 'https');
  const videos = safe.filter(f => f.vcodec?.startsWith('avc1') && f.acodec === 'none' && (f.height || 0) <= 720 && (f.height || 0) >= 144);
  const audios = safe.filter(f => f.vcodec === 'none' && (f.acodec?.startsWith('mp4a') || f.ext === 'm4a')).sort((a, b) => (b.language_preference ?? -1) - (a.language_preference ?? -1) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const selected = [...new Set(videos.map(v => v.height!))].sort((a, b) => b - a).map(height => videos.filter(v => v.height === height).sort((a, b) => (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0))[0]);
  if (!selected.length || !audios.length) throw new PublicError('A compatible video and audio stream is not available for this link. Try another video.', 422);
  const track = (f: Format): Track => ({ url: f.url!, userAgent: f.http_headers?.['User-Agent'] || 'Mozilla/5.0' });
  const expiries = [...selected, audios[0]].map(f => Number(new URL(f.url!).searchParams.get('expire')) * 1000).filter(x => x > Date.now());
  const expiresAt = expiries.length ? Math.min(...expiries.map(x => x - 60_000)) : Date.now() + 60 * 60_000;
  return { title: info.title || 'YouTube video', duration: info.duration || 0, videoId: id, qualities: selected.map(f => ({ height: f.height!, video: track(f) })), audio: track(audios[0]), expiresAt };
}

export async function resolveMedia(id: string, signal: AbortSignal): Promise<ResolvedMedia> {
  try {
    const { stdout } = await execute(process.env.YTDLP_BIN || 'yt-dlp', [
      '--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-playlist', '--no-warnings',
      '--skip-download', '--dump-single-json', '--js-runtimes', 'node', '--socket-timeout', '15',
      '--', `https://www.youtube.com/watch?v=${id}`,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, signal, env: { ...process.env, YTDLP_NO_PLUGINS: '1' } });
    return chooseFormats(JSON.parse(stdout), id);
  } catch (error) {
    if (error instanceof PublicError) throw error;
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new PublicError('The playback service is not configured yet.', 503);
    if (signal.aborted) throw new PublicError('Preparation cancelled.', 409);
    // Never surface yt-dlp output: it can contain signed URLs or diagnostic secrets.
    throw new PublicError('YouTube could not provide this stream. Try another public video or retry shortly.', 502);
  }
}

async function fetchMediaChunk(track: Track, range: string | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new PublicError('Unsupported byte range.', 416);
  let url = track.url;
  for (let redirects = 0; redirects < 4; redirects++) {
    if (!isMediaUrl(url)) throw new PublicError('Invalid media destination.', 502);
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': track.userAgent, ...(range ? { Range: range } : {}) } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url).href;
      continue;
    }
    return response;
  }
  throw new PublicError('The stream redirected too many times.', 502);
}

// YouTube can reject unbounded requests even when the signed URL is valid.
// Fetch bounded chunks while preserving the browser's requested byte interval.
const MEDIA_CHUNK_BYTES = 2 * 1024 * 1024;
export async function fetchMedia(track: Track, range: string | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (!match || !match[1] && !match[2])) throw new PublicError('Unsupported byte range.', 416);
  let start = match?.[1] ? Number(match[1]) : 0;
  let requestedEnd = match?.[1] && match[2] ? Number(match[2]) : Infinity;
  const suffix = match && !match[1] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || requestedEnd !== Infinity && !Number.isSafeInteger(requestedEnd) || requestedEnd < start || suffix !== undefined && (!Number.isSafeInteger(suffix) || suffix < 1)) throw new PublicError('Unsupported byte range.', 416);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const cleanup = () => { signal.removeEventListener('abort', stop); controller.abort(); };
  const request = (from: number, to: number) => fetchMediaChunk(track, `bytes=${from}-${to}`, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), fetcher);
  const contentRange = (response: Response) => {
    const m = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!m) throw new PublicError('The stream returned an invalid byte range.', 502);
    const [from, to, total] = m.slice(1).map(Number);
    if (![from, to, total].every(Number.isSafeInteger) || to < from || to >= total) throw new PublicError('The stream returned an invalid byte range.', 502);
    return { from, to, total };
  };
  const emptyResponse = (response: Response) => {
    if (response.status === 200) throw new PublicError('The stream does not support byte ranges.', 502);
    const headers = new Headers(response.headers); headers.delete('content-length');
    return new Response(null, { status: response.status, headers });
  };
  let response: Response | undefined;
  try {
    if (suffix !== undefined) {
      response = await request(0, 0);
      if (response.status !== 206) { await response.body?.cancel(); cleanup(); return emptyResponse(response); }
      const { total } = contentRange(response);
      await response.body?.cancel(); start = Math.max(0, total - suffix); requestedEnd = total - 1;
    }
    response = await request(start, Math.min(requestedEnd, start + MEDIA_CHUNK_BYTES - 1));
    if (response.status !== 206) {
      await response.body?.cancel(); cleanup();
      if (response.status === 200) throw new PublicError('The stream does not support byte ranges.', 502);
      return emptyResponse(response);
    }
    const firstRange = contentRange(response), end = Math.min(requestedEnd, firstRange.total - 1);
    const first = response;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      let current = first, next = start;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        while (next <= end) {
          const part = contentRange(current);
          if (current.status !== 206 || part.from !== next || part.to > Math.min(end, next + MEDIA_CHUNK_BYTES - 1) || part.total !== firstRange.total || !current.body) throw new PublicError('The stream returned an unexpected byte range.', 502);
          reader = current.body.getReader();
          let remaining = part.to - part.from + 1;
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            remaining -= result.value.byteLength;
            if (remaining < 0) throw new PublicError('The stream returned too much data.', 502);
            yield result.value;
          }
          if (remaining !== 0) throw new PublicError('The stream ended before the requested data arrived.', 502);
          reader.releaseLock(); reader = undefined; next = part.to + 1;
          if (next <= end) current = await request(next, Math.min(end, next + MEDIA_CHUNK_BYTES - 1));
        }
      } finally {
        await reader?.cancel().catch(() => {});
        if (!current.body?.locked) await current.body?.cancel().catch(() => {});
        cleanup();
      }
    }
    const iterator = chunks();
    const body = new ReadableStream<Uint8Array>({
      async pull(target) {
        try { const chunk = await iterator.next(); if (chunk.done) target.close(); else target.enqueue(chunk.value); }
        catch (error) { target.error(error); }
      },
      async cancel() { cleanup(); await iterator.return(undefined); if (!first.body?.locked) await first.body?.cancel().catch(() => {}); },
    });
    const headers = new Headers({ 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes' });
    if (range) headers.set('content-range', `bytes ${start}-${end}/${firstRange.total}`);
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) { cleanup(); await response?.body?.cancel().catch(() => {}); throw error; }
}
