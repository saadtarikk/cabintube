# CabinTube — personal YouTube player MVP

Independent implementation inspired by an observed in-browser player layout and flow. No third-party source, branding assets, credentials or service dependencies. No stored-video library.

Status, 2 October 2026: a personal prototype. Parked browser playback works in the target vehicle browser. In-motion playback is out of scope; see "Scope and limits".

## Run locally

Requirements: Node.js 22.12+, npm, and the pinned `yt-dlp` with Node 22 enabled as its JavaScript runtime. The resolver must run on the same server as the media gateway, because upstream media links can be IP-bound.

```sh
npm install
cp .env.example .env
npm run dev
```

For an isolated, pinned resolver installation (Python 3.10+):

```sh
python3 -m venv .tools/yt-dlp
.tools/yt-dlp/bin/python -m pip install -r requirements-resolver.txt
```

Set `YTDLP_BIN=./.tools/yt-dlp/bin/yt-dlp` in `.env`, then restart the API. `.tools/` is ignored by git. Keep the resolver current as YouTube changes.

Open http://127.0.0.1:4317. The UI runs without Google credentials and reports an unconfigured connection. Account linking and gated search/playback require the Google setup below.

## Google setup

1. Create your own project in [Google Cloud](https://console.cloud.google.com/).
2. Enable **YouTube Data API v3**.
3. Configure Google Auth Platform branding/audience. While testing, add your own Google account as a test user.
4. Create an OAuth client of type **TVs and Limited Input devices**. A Web application client will not work for this device-code endpoint.
5. Put its client ID and client secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Never paste secrets into chat or commit them.
6. Restart the API. Click Connect YouTube, scan the QR, enter the displayed code on Google's page and authorize the read-only YouTube scope.

The QR encodes Google's returned verification URL unchanged. Google device codes, access tokens and refresh tokens stay server-side. The browser receives only the user-facing code, QR and connection state. Polling honors Google's interval, slow-down, denial and expiry responses. Disconnect clears local authorization and attempts provider revocation.

Reference: [Google's device authorization flow and supported scopes](https://developers.google.com/identity/protocols/oauth2/limited-input-device). This reproduces a standard device-pairing interaction using your own client. A device client is for a limited-input interface; review Google's client eligibility before expanding to a general desktop product.

## Playback architecture

1. Google OAuth and YouTube Data API provide account authorization and search metadata. They do **not** provide playable media URLs.
2. A separate `yt-dlp` process resolves a public YouTube video, without user cookies, copied tokens, plugins or local yt-dlp configuration. No account-private, age-restricted, paid or DRM content support is implemented.
3. The server selects available H.264 video up to 720p and AAC-family audio, preferring the extractor's original-language preference over higher-bitrate dubbed tracks. It retains expiring URLs only in memory. No whole-video download or permanent library is created.
4. An opaque, browser-owned playback session exposes same-origin video/audio endpoints. The gateway translates the browser's requested range into bounded upstream requests of at most 2 MiB and streams consecutive chunks with backpressure, preserving the requested range and full response length. It supports seeking, suffix ranges, cancellation, and per-chunk timeouts. Only validated Googlevideo HTTPS destinations are allowed, including redirects. It does not accept arbitrary media URLs from the browser.
5. The player uses browser-native decoding, draws video frames to canvas, and coordinates a separate audio element. Play/pause, seek, mute, speed and available quality controls operate on those tracks.

This first player uses a native video decoder and `requestVideoFrameCallback`, not a custom WebCodecs/MP4Box pipeline. It has no hidden keepalive workaround.

## Scope and limits

- Personal prototype. Parked browser playback only.
- No safety-lock bypass is implemented. Canvas rendering alone establishes nothing about in-motion compatibility.
- H.264 up to 720p and AAC-family audio. No account-private, age-restricted, paid or DRM content.
- yt-dlp resolution success depends on YouTube's current behavior, hosting IP and available formats. Google OAuth success does not guarantee media extraction success.
- Long-duration playback, seamless source renewal and live streams are not yet validated.

## Validation

```sh
npm test
npm run build
```

With the dev server running, `npm run test:browser` uses a separate headless Chrome profile and generated media fixtures. Set `BROWSER_BIN` to another supported browser if needed. `npm run verify:youtube` resolves one public video and fetches 1 KiB of each selected track; it uses no Google account credentials. `npm run verify:playback -- <YouTube-ID-or-URL>` runs an opt-in real-media browser test on an isolated local server on port 4319; it uses fixture OAuth only, never real Google credentials.

Backend tests cover authorization, device polling/slow-down/denial, session ownership, disconnection, media URL validation, unsafe redirects and Range forwarding. Browser verification uses explicit test fixtures, not a product demo mode.

## Deployment

The service runs as a Docker Compose project; see `compose.yaml` and `Dockerfile`. The container runs as a non-root user, relays media without FFmpeg, publishes only `127.0.0.1:4318`, and uses a read-only root filesystem except `/data` and temporary storage.

Production startup requires an HTTPS `APP_ORIGIN`, `ACCESS_CODE_HASH`, `SESSION_FILE` and `SESSION_KEY`. The access code gates Google connection and all playback APIs. With `SESSION_FILE` and `SESSION_KEY` set, authorized sessions and tokens are stored with AES-256-GCM encryption and restored after restart. Keep the encryption key with your private deployment configuration.

If you expose the service through a public reverse proxy or tunnel, keep the access-code gate enabled and use a long, high-entropy code. A short code is brute-forceable on a public endpoint.

## Licensing

Third-party dependencies remain under their own licenses; the `yt-dlp` executable is a separate dependency. No ownership or licence claim is made over YouTube content. Review the [yt-dlp project](https://github.com/yt-dlp/yt-dlp) and [YouTube API policies](https://developers.google.com/youtube/terms/developer-policies) before any distribution.
