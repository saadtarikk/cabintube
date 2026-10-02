export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to connect. Please retry.');
  return data;
}
export type Playback = { id: string; startAt?: number; state: 'ready'; title: string; duration: number; videoId: string; audio: string; qualities: { height: number; url: string }[]; expiresAt: number };
export type Video = { id: string; title: string; channel: string; thumbnail: string; publishedAt: string };
export const text = (input: string) => { const doc = new DOMParser().parseFromString(input, 'text/html'); return doc.documentElement.textContent || ''; };
export const time = (seconds: number) => { const s = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
