import { createApp } from './app.ts';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production' && (!process.env.ACCESS_CODE_HASH || !process.env.SESSION_KEY || !process.env.SESSION_FILE || !process.env.APP_ORIGIN?.startsWith('https://'))) throw new Error('Production needs HTTPS APP_ORIGIN, ACCESS_CODE_HASH and SESSION_KEY.');
const app = await createApp({ accessCodeHash: process.env.ACCESS_CODE_HASH, storage: process.env.SESSION_FILE && process.env.SESSION_KEY ? { file: process.env.SESSION_FILE, key: process.env.SESSION_KEY } : undefined, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, origin: process.env.APP_ORIGIN || 'http://127.0.0.1:4317' });
const root = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(root)) await app.register(fastifyStatic, { root });
await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4318) });
console.log(`CabinTube API ready on port ${process.env.PORT || 4318}. Google connection ${process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'configured' : 'awaiting setup'}.`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
