import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { PublicError, videoId, resolveMedia, fetchMedia, type ResolvedMedia } from './media.ts';

import { sessionStore, type Viewer, type SessionStorage } from './sessions.ts';
const SESSION_TTL = 30 * 24 * 60 * 60_000;

type Job = { owner: string; controller: AbortController; state: 'preparing' | 'ready' | 'error'; error?: string; media?: ResolvedMedia; createdAt: number };
type Config = { clientId?: string; clientSecret?: string; origin: string; accessCodeHash?: string; storage?: SessionStorage; fetcher?: typeof fetch; resolver?: typeof resolveMedia };
const randomId = () => randomBytes(24).toString('base64url');

export async function createApp(config: Config) {
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const fetcher = config.fetcher || fetch;
  const resolver = config.resolver || resolveMedia;
  const { viewers, save } = await sessionStore(config.storage);
  if (config.accessCodeHash && !/^[a-f0-9]{64}$/.test(config.accessCodeHash)) throw new Error('ACCESS_CODE_HASH must be a SHA-256 hex digest.');
  const jobs = new Map<string, Job>();
  const configured = Boolean(config.clientId && config.clientSecret);
  await app.register(cookie);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & { statusCode?: number };
    reply.code(e.statusCode || 500).send({ error: error instanceof PublicError ? e.message : e.statusCode === 429 ? 'Please wait a moment and retry.' : 'Something went wrong. Please try again.' });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    // Host validation prevents DNS rebinding against a locally running service.
    const allowedHosts = new Set([new URL(config.origin).host, `127.0.0.1:${process.env.PORT || 4318}`, `localhost:${process.env.PORT || 4318}`]);
    if (!allowedHosts.has(req.headers.host || '')) throw new PublicError('Unrecognized host.', 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.origin) throw new PublicError('Request origin is not allowed.', 403);
  });
  app.addHook('preHandler', async req => {
    if (config.accessCodeHash && req.url.startsWith('/api/') && !['/api/status', '/api/unlock', '/api/health'].includes(req.url.split('?')[0]) && !session(req)[1].unlocked) throw new PublicError('Unlock CabinTube to continue.', 403);
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.post<{ Body: { code?: string } }>('/api/unlock', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async req => {
    const [, viewer] = session(req);
    const digest = createHash('sha256').update(typeof req.body?.code === 'string' ? req.body.code.trim() : '').digest();
    if (config.accessCodeHash && !timingSafeEqual(digest, Buffer.from(config.accessCodeHash, 'hex'))) throw new PublicError('That access code is incorrect.', 403);
    viewer.unlocked = true; await save(); return { ok: true };
  });
  function session(req: { cookies: Record<string, string | undefined> }): [string, Viewer] {
    const id = req.cookies.cabintube || '';
    const viewer = viewers.get(id);
    if (!viewer || viewer.expiresAt < Date.now()) throw new PublicError('Please reconnect to continue.', 401);
    viewer.expiresAt = Date.now() + SESSION_TTL;
    return [id, viewer];
  }
  async function googleForm(path: string, data: Record<string, string>) {
    const r = await fetcher(`https://oauth2.googleapis.com/${path}`, { method: 'POST', body: new URLSearchParams(data), signal: AbortSignal.timeout(20_000) });
    return { ok: r.ok, data: await r.json() as Record<string, any> };
  }
  async function access(viewer: Viewer): Promise<string> {
    if (viewer.accessToken && (viewer.tokenExpiresAt || 0) > Date.now() + 30_000) return viewer.accessToken;
    if (viewer.refreshToken) {
      const r = await googleForm('token', { client_id: config.clientId!, client_secret: config.clientSecret!, refresh_token: viewer.refreshToken, grant_type: 'refresh_token' });
      if (r.ok && r.data.access_token) {
        viewer.accessToken = r.data.access_token; viewer.tokenExpiresAt = Date.now() + r.data.expires_in * 1000;
        await save(); return viewer.accessToken!;
      }
    }
    delete viewer.accessToken; delete viewer.refreshToken; await save();
    throw new PublicError('Connect YouTube to continue.', 401);
  }
  app.get('/api/status', async (req, reply) => {
    let id = req.cookies.cabintube || '';
    let viewer = viewers.get(id);
    if (!viewer || viewer.expiresAt < Date.now()) {
      if (viewers.size >= 500) throw new PublicError('The service is busy. Please try again shortly.', 503);
      id = randomId(); viewer = { expiresAt: Date.now() + SESSION_TTL }; viewers.set(id, viewer);
    }
    reply.setCookie('cabintube', id, { httpOnly: true, sameSite: 'strict', path: '/', secure: config.origin.startsWith('https:'), maxAge: SESSION_TTL / 1000 });
    viewer.expiresAt = Date.now() + SESSION_TTL;
    if (viewer.unlocked || viewer.refreshToken || viewer.accessToken) await save();
    return { ...(config.accessCodeHash ? { locked: !viewer.unlocked } : {}), connected: Boolean(viewer.refreshToken || (viewer.accessToken && (viewer.tokenExpiresAt || 0) > Date.now())), configured };
  });
  app.post('/api/youtube/connect', async (req) => {
    const [, viewer] = session(req);
    if (!configured) throw new PublicError('YouTube connection is not available yet. Please try again after setup.', 503);
    if (viewer.pending && viewer.pending.expiresAt > Date.now()) return deviceView(viewer.pending);
    const r = await googleForm('device/code', { client_id: config.clientId!, scope: 'https://www.googleapis.com/auth/youtube.readonly' });
    if (!r.ok || !r.data.device_code || !r.data.user_code || !r.data.verification_url) throw new PublicError('Google could not start the connection. Check the app’s Google authorization setup.', 502);
    const verification = new URL(r.data.verification_url);
    if (verification.protocol !== 'https:' || !['www.google.com', 'google.com', 'accounts.google.com'].includes(verification.hostname)) throw new PublicError('Google returned an unexpected verification destination.', 502);
    viewer.pending = { deviceCode: r.data.device_code, userCode: r.data.user_code, verificationUrl: verification.href, expiresAt: Date.now() + r.data.expires_in * 1000, interval: Math.max(5, r.data.interval || 5), nextPoll: Date.now() + Math.max(5, r.data.interval || 5) * 1000 };
    return deviceView(viewer.pending);
  });
  async function deviceView(p: NonNullable<Viewer['pending']>) {
    // Encode Google's returned URL unchanged; the user enters the displayed code.
    return { userCode: p.userCode, verificationUrl: p.verificationUrl, qr: await QRCode.toDataURL(p.verificationUrl, { margin: 2, width: 256 }), expiresAt: p.expiresAt, interval: p.interval };
  }
  app.get('/api/youtube/connect/status', async req => {
    const [, viewer] = session(req); const p = viewer.pending;
    if (!p) return { status: viewer.accessToken ? 'connected' : 'expired' };
    if (p.expiresAt <= Date.now()) { delete viewer.pending; return { status: 'expired' }; }
    if (p.polling || Date.now() < p.nextPoll) return { status: 'pending', interval: p.interval };
    p.polling = true; p.nextPoll = Date.now() + p.interval * 1000;
    try {
      const r = await googleForm('token', { client_id: config.clientId!, client_secret: config.clientSecret!, device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (viewer.pending !== p) return { status: 'expired' };
      if (r.ok && r.data.access_token) {
        viewer.accessToken = r.data.access_token; viewer.refreshToken = r.data.refresh_token;
        viewer.tokenExpiresAt = Date.now() + r.data.expires_in * 1000; delete viewer.pending;
        await save(); return { status: 'connected' };
      }
      if (r.data.error === 'authorization_pending') return { status: 'pending', interval: p.interval };
      if (r.data.error === 'slow_down') { p.interval += 5; p.nextPoll = Date.now() + p.interval * 1000; return { status: 'pending', interval: p.interval }; }
      delete viewer.pending;
      return { status: r.data.error === 'access_denied' ? 'denied' : 'expired' };
    } finally { p.polling = false; }
  });
  app.delete('/api/youtube/connect/pending', async req => { delete session(req)[1].pending; return { ok: true }; });
  app.delete('/api/youtube/connect', async req => {
    const [id, viewer] = session(req); const token = viewer.refreshToken || viewer.accessToken;
    // Local disconnect always succeeds, even if the provider cannot be reached.
    delete viewer.accessToken; delete viewer.refreshToken; delete viewer.pending; await save();
    for (const [key, job] of jobs) if (job.owner === id) { job.controller.abort(); jobs.delete(key); }
    let revoked = !token;
    if (token) { try { const r = await fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) }); revoked = r.ok; } catch {} }
    return { ok: true, revoked };
  });
  app.get<{ Querystring: { q?: string } }>('/api/youtube/search', async req => {
    const [, viewer] = session(req); const token = await access(viewer);
    const query = req.query.q?.trim();
    if (!query || query.length > 200) throw new PublicError('Enter a search of up to 200 characters.');
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '18', q: query });
    const response = await fetcher(`https://www.googleapis.com/youtube/v3/search?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new PublicError(response.status === 403 ? 'YouTube search is unavailable. The app’s API access or daily quota may need attention.' : 'Search could not load. Please retry.', 502);
    const data = await response.json() as any;
    return { items: (data.items || []).map((v: any) => ({ id: v.id.videoId, title: v.snippet.title, channel: v.snippet.channelTitle, publishedAt: v.snippet.publishedAt, thumbnail: `https://i.ytimg.com/vi/${encodeURIComponent(v.id.videoId)}/hqdefault.jpg` })) };
  });
  app.post<{ Body: { url?: string } }>('/api/playback', async req => {
    const [owner, viewer] = session(req); await access(viewer);
    if (typeof req.body?.url !== 'string') throw new PublicError('Paste a YouTube link.');
    const id = videoId(req.body.url);
    for (const [key, job] of jobs) if (job.owner === owner) { job.controller.abort(); jobs.delete(key); }
    if ([...jobs.values()].filter(j => j.state === 'preparing').length >= 2) throw new PublicError('The player is busy preparing another video. Please retry shortly.', 503);
    const key = randomId(); const job: Job = { owner, state: 'preparing', controller: new AbortController(), createdAt: Date.now() }; jobs.set(key, job);
    void resolver(id, job.controller.signal).then(media => { if (!job.controller.signal.aborted) { job.media = media; job.state = 'ready'; } }).catch(error => { job.state = 'error'; job.error = error instanceof PublicError ? error.message : 'The video could not be prepared. Please retry.'; });
    return { id: key, state: job.state };
  });
  function owned(id: string, owner: string) {
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw new PublicError('Playback session not found.', 404);
    if ((job.media?.expiresAt || job.createdAt + 90_000) < Date.now()) { job.controller.abort(); jobs.delete(id); throw new PublicError('This stream has expired. Reopen the video to continue.', 410); }
    return job;
  }
  app.get<{ Params: { id: string } }>('/api/playback/:id', async req => {
    const job = owned(req.params.id, session(req)[0]);
    if (!job.media) return { state: job.state, error: job.error };
    return { state: 'ready', title: job.media.title, duration: job.media.duration, videoId: job.media.videoId, expiresAt: job.media.expiresAt, audio: `/api/playback/${req.params.id}/media/audio`, qualities: job.media.qualities.map(q => ({ height: q.height, url: `/api/playback/${req.params.id}/media/${q.height}` })) };
  });
  app.delete<{ Params: { id: string } }>('/api/playback/:id', async req => {
    const job = owned(req.params.id, session(req)[0]); job.controller.abort(); jobs.delete(req.params.id); return { ok: true };
  });
  app.get<{ Params: { id: string; track: string } }>('/api/playback/:id/media/:track', async (req, reply) => {
    const job = owned(req.params.id, session(req)[0]);
    if (!job.media) throw new PublicError('The video is still being prepared.', 409);
    const track = req.params.track === 'audio' ? job.media.audio : job.media.qualities.find(q => String(q.height) === req.params.track)?.video;
    if (!track) throw new PublicError('This quality is unavailable.', 404);
    const controller = new AbortController();
    const stop = () => controller.abort();
    job.controller.signal.addEventListener('abort', stop, { once: true });
    reply.raw.once('close', () => { stop(); job.controller.signal.removeEventListener('abort', stop); });
    const upstream = await fetchMedia(track, req.headers.range, controller.signal, fetcher);
    if (![200, 206, 416].includes(upstream.status)) { await upstream.body?.cancel(); throw new PublicError('The stream connection failed. Reopen the video to retry.', 502); }
    reply.code(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name); if (value) reply.header(name, value);
    }
    return reply.send(upstream.body ? Readable.fromWeb(upstream.body as any) : '');
  });
  const cleanup = setInterval(() => {
    for (const [id, viewer] of viewers) if (viewer.expiresAt < Date.now()) viewers.delete(id);
    for (const [id, job] of jobs) if (!viewers.has(job.owner) || (job.media?.expiresAt || job.createdAt + 90_000) < Date.now()) { job.controller.abort(); jobs.delete(id); }
  }, 30_000); cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); await save(); for (const job of jobs.values()) job.controller.abort(); viewers.clear(); jobs.clear(); });
  return app;
}
