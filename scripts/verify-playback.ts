// Opt-in browser test: real resolver, relay and media; isolated fixture OAuth only.
// May load YTDLP_BIN from .env; never uses its Google credentials or changes the normal app session.
import { chromium, expect } from '@playwright/test';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server/app.ts';
import { videoId } from '../server/media.ts';

const id = videoId(process.argv[2] || 'aqz-KE-bpKQ');
const origin = 'http://127.0.0.1:4319';
process.env.PORT = '4319';
const realFetch = globalThis.fetch;
const fetcher: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/device/code') return Response.json({ device_code: 'local-fixture', user_code: 'LOCAL', verification_url: 'https://www.google.com/device', expires_in: 60, interval: 5 });
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'local-fixture', expires_in: 3600 });
  return realFetch(input, init);
};
const app = await createApp({ origin, clientId: 'fixture', clientSecret: 'fixture', fetcher });
await app.register(fastifyStatic, { root: fileURLToPath(new URL('../dist', import.meta.url)) });
await app.listen({ host: '127.0.0.1', port: 4319 });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_BIN || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', args: ['--autoplay-policy=no-user-gesture-required'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const failures: number[] = [];
  page.on('response', response => { if (response.url().includes('/media/') && response.status() >= 400) failures.push(response.status()); });
  await page.request.get(`${origin}/api/status`);
  await page.request.post(`${origin}/api/youtube/connect`, { headers: { Origin: origin } });
  await page.waitForTimeout(5100);
  const auth = await page.request.get(`${origin}/api/youtube/connect/status`);
  if ((await auth.json()).status !== 'connected') throw new Error('Local fixture authorization failed');
  await page.goto(origin);
  await page.getByRole('button', { name: 'Open a video link', exact: true }).click();
  await page.getByLabel('VIDEO LINK', { exact: true }).fill(`https://www.youtube.com/watch?v=${id}`);
  await page.getByRole('button', { name: 'Prepare video', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Video player' })).toBeVisible({ timeout: 75000 });
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime), { timeout: 30000 }).toBeGreaterThan(3);
  await expect.poll(() => page.locator('audio').evaluate(v => (v as HTMLAudioElement).currentTime), { timeout: 30000 }).toBeGreaterThan(3);
  const picture = await page.locator('canvas').evaluate(c => {
    const ctx = (c as HTMLCanvasElement).getContext('2d')!;
    return ctx.getImageData(0, 0, c.width, c.height).data.some((n, i) => i % 4 !== 3 && n > 20);
  });
  if (!picture) throw new Error('Canvas picture is black');
  const duration = Number(await page.getByRole('slider', { name: 'Seek video' }).getAttribute('max'));
  const target = Math.floor(duration * .8);
  await page.getByRole('slider', { name: 'Seek video' }).fill(String(target));
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime), { timeout: 30000 }).toBeGreaterThan(target + 2);
  await expect.poll(() => page.locator('audio').evaluate(v => (v as HTMLAudioElement).currentTime), { timeout: 30000 }).toBeGreaterThan(target + 2);
  const drift = await page.evaluate(() => Math.abs(document.querySelector('video')!.currentTime - document.querySelector('audio')!.currentTime));
  expect(drift).toBeLessThan(.4);
  await mkdir('/private/tmp/cabintube-verification', { recursive: true });
  await page.screenshot({ path: `/private/tmp/cabintube-verification/live-${id}.png` });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Video player' })).toHaveCount(0);
  expect(failures).toEqual([]);
  console.log(JSON.stringify({ videoId: id, browser: 'Chromium', picture, audioAdvanced: true, seekSeconds: target, avDriftSeconds: drift, failedMediaRequests: failures.length, passed: true }));
} catch (e) {
  // No upstream URLs or credentials in diagnostics.
  console.log(JSON.stringify({ videoId: id, passed: false, error: (e as Error).message.slice(0, 700) }));
  process.exitCode = 1;
} finally { await browser.close(); await app.close(); }
