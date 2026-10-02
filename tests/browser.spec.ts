import { test, expect, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
const dir = '/private/tmp/cabintube-verification';

test.beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '12', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${dir}/video.mp4`]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:a', 'aac', '-movflags', '+faststart', `${dir}/audio.m4a`]);
});

test('unconfigured home is honest and usable at desktop and mobile widths', async ({ page }) => {
  await page.route('**/api/status', r => r.fulfill({ json: { connected: false, configured: false } }));
  await page.route('**/api/youtube/connect', r => r.fulfill({ status: 503, json: { error: 'YouTube connection is not available yet. Please try again after setup.' } }));
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your YouTube. Your space.' })).toBeVisible();
  await page.screenshot({ path: `${dir}/home-desktop.png`, fullPage: true });
  await page.getByRole('button', { name: 'Connect YouTube', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('not available yet');
  await expect(page.getByAltText('QR code for Google device authorization')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${dir}/home-mobile.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('link preparation, canvas picture, separate audio, pause, seek and quality switch', async ({ page }) => {
  await page.route('**/api/status', r => r.fulfill({ json: { connected: true, configured: true } }));
  await page.route('**/api/playback', r => r.fulfill({ json: { id: 'fixture-session', state: 'preparing' } }));
  let polls = 0;
  await page.route('**/api/playback/fixture-session', r => r.request().method() === 'DELETE' ? r.fulfill({ json: { ok: true } }) : r.fulfill({ json: ++polls < 3 ? { state: 'preparing' } : { state: 'ready', title: 'Generated playback test', videoId: 'fixture0001', duration: 12, expiresAt: Date.now() + 60000, audio: '/fixture/audio.m4a', qualities: [{ height: 720, url: '/fixture/video.mp4' }, { height: 360, url: '/fixture/video.mp4?quality=360' }] } }));
  async function mediaRoute(route: Route, file: string, type: string) {
    const data = readFileSync(`${dir}/${file}`), range = route.request().headers().range;
    if (!range) return route.fulfill({ body: data, contentType: type, headers: { 'accept-ranges': 'bytes' } });
    const match = /bytes=(\d+)-(\d*)/.exec(range)!; const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : data.length - 1, data.length - 1);
    await route.fulfill({ status: 206, contentType: type, body: data.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${data.length}` } });
  }
  await page.route('**/fixture/video.mp4*', r => mediaRoute(r, 'video.mp4', 'video/mp4'));
  await page.route('**/fixture/audio.m4a', r => mediaRoute(r, 'audio.m4a', 'audio/mp4'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a video link', exact: true }).click();
  await page.getByLabel('VIDEO LINK', { exact: true }).fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await page.getByRole('button', { name: 'Prepare video', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Preparing video' })).toBeVisible();
  await page.screenshot({ path: `${dir}/processing.png`, fullPage: true });
  await expect(page.getByRole('dialog', { name: 'Video player' })).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(1);
  await expect.poll(() => page.locator('audio').evaluate(a => (a as HTMLAudioElement).currentTime)).toBeGreaterThan(1);
  const pixel = await page.locator('canvas').evaluate(c => Array.from((c as HTMLCanvasElement).getContext('2d')!.getImageData(100, 100, 1, 1).data));
  expect(pixel.slice(0, 3).some(v => v > 20)).toBe(true);
  await page.screenshot({ path: `${dir}/player.png` });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime);
  await page.waitForTimeout(400);
  expect(await page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeCloseTo(paused, 1);
  await page.getByRole('slider', { name: 'Seek video' }).fill('6');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate(a => (a as HTMLAudioElement).currentTime)).toBeGreaterThan(6);
  await page.getByLabel('Video quality').selectOption('360');
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(6);
  const drift = await page.evaluate(() => Math.abs(document.querySelector('video')!.currentTime - document.querySelector('audio')!.currentTime));
  expect(drift).toBeLessThan(.4);
  await page.locator('video').evaluate(v => v.dispatchEvent(new Event('error')));
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(6);
  await expect.poll(() => page.locator('audio').evaluate(v => (v as HTMLAudioElement).currentTime)).toBeGreaterThan(6);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Video player' })).toHaveCount(0);
});

test('public access screen unlocks before showing YouTube controls', async ({ page }) => {
  await page.route('**/api/status', r => r.fulfill({ json: { connected: false, configured: true, locked: true } }));
  await page.route('**/api/unlock', r => r.request().postDataJSON().code === 'fixture-access-code'
    ? r.fulfill({ json: { ok: true } }) : r.fulfill({ status: 403, json: { error: 'That access code is incorrect.' } }));
  await page.goto('/');
  await expect(page.getByLabel('ACCESS CODE', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect YouTube', exact: true })).toHaveCount(0);
  await page.getByLabel('ACCESS CODE', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Open CabinTube', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('ACCESS CODE', { exact: true }).fill('fixture-access-code');
  await page.getByRole('button', { name: 'Open CabinTube', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your YouTube. Your space.' })).toBeVisible();
});
