import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CheckCircle2, ChevronRight, CirclePlay, Home, Link, LoaderCircle, LogOut, Search, ShieldCheck, Sparkles, X, Youtube } from 'lucide-react';
import { api, text, type Playback, type Video } from './api';
import Dialog from './Dialog';
import Player from './Player';

type Pairing = { userCode: string; qr: string; verificationUrl: string; expiresAt: number; interval: number };
type Preparing = { id?: string; step: number; title: string; error?: string };

export default function App() {
  const [locked, setLocked] = useState(false), [accessCode, setAccessCode] = useState(''), [unlocking, setUnlocking] = useState(false);
  const [connected, setConnected] = useState(false), [booting, setBooting] = useState(true), [query, setQuery] = useState('');
  const [results, setResults] = useState<Video[]>([]), [searched, setSearched] = useState(''), [searching, setSearching] = useState(false), [error, setError] = useState('');
  const [connectOpen, setConnectOpen] = useState(false), [pairing, setPairing] = useState<Pairing>(), [connectError, setConnectError] = useState(''), [connecting, setConnecting] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false), [link, setLink] = useState(''), [preparing, setPreparing] = useState<Preparing>(), [playback, setPlayback] = useState<Playback>();
  const operation = useRef(0), connectOperation = useRef(0), searchOperation = useRef(0), activeJob = useRef<string | undefined>(undefined), pendingInput = useRef('');
  useEffect(() => { void api<{ connected: boolean; locked?: boolean }>('/status').then(s => { setConnected(s.connected); setLocked(Boolean(s.locked)); }).catch(e => setError(e.message)).finally(() => setBooting(false)); }, []);
  useEffect(() => {
    if (!pairing || !connectOpen) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (cancelled) return;
      if (Date.now() >= pairing!.expiresAt) { setConnectError('This code has expired. Close this window and connect again.'); return; }
      try {
        const result = await api<{ status: string; interval?: number }>('/youtube/connect/status');
        if (cancelled) return;
        if (result.status === 'connected') { setConnected(true); setConnectOpen(false); setPairing(undefined); return; }
        if (result.status === 'denied' || result.status === 'expired') { setConnectError(result.status === 'denied' ? 'Connection was declined. Close this window to try again.' : 'This code has expired. Close this window to try again.'); return; }
        timer = setTimeout(poll, (result.interval || pairing!.interval) * 1000);
      } catch (e) { if (!cancelled) setConnectError((e as Error).message); }
    }
    timer = setTimeout(poll, pairing.interval * 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pairing, connectOpen]);

  async function connect() {
    if (connecting) return;
    const version = ++connectOperation.current;
    setConnectOpen(true); setConnectError(''); setPairing(undefined); setConnecting(true);
    try { const p = await api<Pairing>('/youtube/connect', { method: 'POST', body: '{}' }); if (version === connectOperation.current) setPairing(p); }
    catch (e) { if (version === connectOperation.current) setConnectError((e as Error).message); }
    finally { if (version === connectOperation.current) setConnecting(false); }
  }
  function closeConnect() { connectOperation.current++; setConnecting(false); setConnectOpen(false); setPairing(undefined); void api('/youtube/connect/pending', { method: 'DELETE' }).catch(() => {}); }
  async function disconnect() {
    try { const r = await api<{ revoked: boolean }>('/youtube/connect', { method: 'DELETE' }); operation.current++; searchOperation.current++; setConnected(false); setResults([]); setSearched(''); setSearching(false); setPlayback(undefined); setPreparing(undefined); if (!r.revoked) setError('Disconnected here. Google could not revoke access; you can remove it in your Google account settings.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!connected) { void connect(); return; }
    if (!query.trim()) return;
    if (/^https?:\/\//i.test(query.trim())) { void prepare(query); return; }
    const version = ++searchOperation.current;
    setSearching(true); setError('');
    try { const r = await api<{ items: Video[] }>(`/youtube/search?q=${encodeURIComponent(query.trim())}`); if (version === searchOperation.current) { setResults(r.items); setSearched(query.trim()); } }
    catch (e) { if (version === searchOperation.current) setError((e as Error).message); }
    finally { if (version === searchOperation.current) setSearching(false); }
  }
  async function prepare(input: string, title = 'Getting your video ready', startAt = 0) {
    if (!connected) { void connect(); return; }
    const version = ++operation.current; pendingInput.current = input;
    setPlayback(undefined); setLinkOpen(false); setError(''); setPreparing({ step: 0, title });
    if (activeJob.current) void api(`/playback/${activeJob.current}`, { method: 'DELETE' }).catch(() => {});
    try {
      const start = await api<{ id: string }>('/playback', { method: 'POST', body: JSON.stringify({ url: input }) });
      if (version !== operation.current) { void api(`/playback/${start.id}`, { method: 'DELETE' }).catch(() => {}); return; }
      activeJob.current = start.id; setPreparing({ id: start.id, step: 1, title });
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline && version === operation.current) {
        const status = await api<Omit<Playback, 'id'> | { state: 'preparing' | 'error'; error?: string }>(`/playback/${start.id}`);
        if (version !== operation.current) return;
        if (status.state === 'error') throw new Error(status.error || 'This video could not be prepared.');
        if (status.state === 'ready') { setPreparing({ id: start.id, step: 2, title }); await new Promise(r => setTimeout(r, 350)); if (version === operation.current) { setPlayback({ ...status, id: start.id, startAt }); setPreparing(undefined); } return; }
        await new Promise(r => setTimeout(r, 700));
      }
      if (version === operation.current) throw new Error('Preparation took too long. Please retry.');
    } catch (e) { if (version === operation.current) setPreparing({ step: 1, title, error: (e as Error).message }); }
  }
  function stop() { operation.current++; setPreparing(undefined); setPlayback(undefined); if (activeJob.current) { void api(`/playback/${activeJob.current}`, { method: 'DELETE' }).catch(() => {}); activeJob.current = undefined; } }
  function home() { searchOperation.current++; setQuery(''); setResults([]); setSearched(''); setError(''); setSearching(false); }

  if (locked) return <div className="app-shell"><main className="welcome"><div className="welcome-mark"><ShieldCheck size={54} /></div><h1>Welcome to<br /><span>CabinTube.</span></h1><p className="welcome-description">Enter your access code to open your personal player.</p><form style={{ width: 'min(360px, 90vw)' }} onSubmit={async e => { e.preventDefault(); setUnlocking(true); setError(''); try { await api('/unlock', { method: 'POST', body: JSON.stringify({ code: accessCode }) }); setLocked(false); setAccessCode(''); } catch (e) { setError((e as Error).message); } finally { setUnlocking(false); } }}><label className="field-label" htmlFor="access-code">ACCESS CODE</label><input id="access-code" className="link-input" type="password" autoComplete="current-password" value={accessCode} onChange={e => setAccessCode(e.target.value)} required /><button className="primary full-width" disabled={unlocking}>{unlocking ? 'Opening…' : 'Open CabinTube'}</button>{error && <p role="alert">{error}</p>}</form></main></div>;
  return <div className="app-shell">
    <div className="ambient" aria-hidden="true"><div className="ambient-line" /></div>
    <header className="topbar">
      <button className="home-button glass" aria-label="Home" onClick={home}><Home size={24} /></button>
      <form className="search-bar" onSubmit={search}>
        <button type="button" className="link-button" title="Open a YouTube link" aria-label="Open a YouTube link" disabled={booting} onClick={() => connected ? setLinkOpen(true) : void connect()}><Link size={23} /></button>
        <div className="search-field glass"><Search size={22} /><input aria-label="Search YouTube or paste a link" placeholder="Search YouTube or paste a link…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>↵</kbd></div>
        <button className="search-button" disabled={booting || searching}>{searching ? <LoaderCircle className="spin" size={22} /> : 'Search'}</button>
      </form>
      <button className={`connect-button glass ${connected ? 'is-connected' : ''}`} disabled={booting} onClick={() => connected ? void disconnect() : void connect()} aria-label={connected ? 'Disconnect YouTube' : 'Connect YouTube'}><Youtube size={28} fill="#f12245" strokeWidth={1.4} /><span>YouTube</span>{connected ? <><span className="connected-label"><Check size={16} /> Connected</span><LogOut size={17} /></> : <strong>Connect</strong>}</button>
    </header>
    <main>
      <div className="section-bar"><div className="section-title"><CirclePlay size={19} /><span>YOUTUBE</span></div><span className="connection-status"><span className={`status-dot ${connected ? '' : 'offline'}`} />{connected ? 'Your account is connected' : 'Your personal viewing space'}</span></div>
      {error && <div className="notice" role="alert">{error}<button className="icon-button" aria-label="Dismiss message" onClick={() => setError('')}><X size={18} /></button></div>}
      {!searched && !searching && <section className="welcome">
        <div className="welcome-mark"><Youtube size={58} strokeWidth={1.2} /><span className="mark-orbit" /></div>
        <p className="eyebrow">TAKE A MOMENT. PRESS PLAY.</p>
        <h1>Your YouTube.<br /><span>Your space.</span></h1>
        <p className="welcome-description">{connected ? 'Find something worth watching. Search above or bring a link of your own.' : 'Connect your account, find a video, and settle in. A simple player, made for your cabin.'}</p>
        <button className="primary welcome-action" disabled={booting} onClick={() => connected ? setLinkOpen(true) : void connect()}>{booting ? <LoaderCircle className="spin" size={20} /> : connected ? <Link size={20} /> : <Youtube size={23} />}{connected ? 'Open a video link' : 'Connect YouTube'}<ArrowRight size={19} /></button>
        <div className="welcome-caption">{connected ? <><CheckCircle2 size={14} /> Ready when you are</> : <><ShieldCheck size={14} /> Sign in securely with Google</>}</div>
        <div className="journey"><span><span className="journey-number">01</span> Connect</span><ChevronRight size={15} /><span><span className="journey-number">02</span> Find a video</span><ChevronRight size={15} /><span><span className="journey-number">03</span> Press play</span></div>
      </section>}
      {searching && <div className="results-loading" role="status"><LoaderCircle className="spin" size={28} /> Searching YouTube</div>}
      {searched && !searching && <section className="results"><div className="results-heading"><h2>Results for <span>“{searched}”</span></h2><span>{results.length} videos</span></div>{results.length ? <div className="video-grid">{results.map(v => <button className="video-card" key={v.id} onClick={() => void prepare(v.id, text(v.title))}><div className="thumbnail"><img alt="" src={v.thumbnail} loading="lazy" /><span className="card-play"><CirclePlay size={42} strokeWidth={1.2} /></span></div><div className="card-info"><span className="channel-avatar">{text(v.channel).slice(0, 1)}</span><div><h3>{text(v.title)}</h3><p>{text(v.channel)}</p></div></div></button>)}</div> : <div className="empty-results"><Search size={34} /><h3>No videos found</h3><p>Try a different search or paste a YouTube link.</p></div>}</section>}
    </main>
    <footer><span className="wordmark">CABIN<span>TUBE</span><i /></span><span>Less scrolling. More watching.</span><div className="footer-status"><span className="status-dot" /> PERSONAL PLAYER</div></footer>
    {connectOpen && <Dialog title="Connect YouTube" close={closeConnect} className="connect-dialog"><Youtube className="youtube-mark" size={49} /><h2>Connect YouTube</h2><p className="dialog-description">Scan with your phone, then enter the code<br />and continue with your Google account.</p>{connecting && <div className="qr-loading" role="status"><LoaderCircle size={32} className="spin" /><span>Getting your code</span></div>}{pairing && !connectError && <><div className="qr-frame"><img src={pairing.qr} alt="QR code for Google device authorization" width={232} height={232} /></div><div className="pair-code">{pairing.userCode}</div><a className="verification-link" href={pairing.verificationUrl} target="_blank" rel="noreferrer">Or continue on this device <ArrowRight size={15} /></a><div className="pair-waiting"><LoaderCircle className="spin" size={15} /> Waiting for confirmation</div></>}{connectError && <div className="dialog-error" role="alert">{connectError}</div>}<button className="secondary full-width" onClick={closeConnect}>Close</button></Dialog>}
    {linkOpen && <Dialog title="Open a YouTube link" close={() => setLinkOpen(false)}><div className="dialog-icon"><Link size={28} /></div><h2>Bring your own link</h2><p className="dialog-description">Paste a YouTube video and we’ll get it ready.</p><form onSubmit={e => { e.preventDefault(); void prepare(link); }}><label className="field-label" htmlFor="video-link">VIDEO LINK</label><input id="video-link" className="link-input" placeholder="https://www.youtube.com/watch?v=…" value={link} onChange={e => setLink(e.target.value)} required /><button className="primary full-width" type="submit">Prepare video <ArrowRight size={18} /></button></form></Dialog>}
    {preparing && <Dialog title="Preparing video" close={stop} className="processing-dialog"><div className="processing-heading"><div className={`processing-ring ${preparing.step === 2 ? 'done' : ''}`}>{preparing.step === 2 ? <Check size={28} /> : <LoaderCircle className="spin" size={37} />}</div><div><span className="eyebrow">JUST A MOMENT</span><h2>{preparing.error ? 'Let’s try again' : preparing.step === 2 ? 'Ready to play' : preparing.step === 0 ? 'Preparation' : 'Processing'}{!preparing.error && preparing.step < 2 && <span className="processing-dot" />}</h2></div></div><p className="processing-title">{preparing.title}</p>{preparing.error ? <div className="dialog-error" role="alert">{preparing.error}</div> : <div className={`processing-track ${preparing.step === 2 ? 'complete' : ''}`} role="progressbar" aria-label="Video preparation" aria-valuetext={preparing.step === 2 ? 'Ready' : 'Preparing compatible streams'}><span /></div>}<div className="processing-steps">{['Preparation', 'Processing', 'Done'].map((label, i) => <div className={preparing.step === i ? 'active' : preparing.step > i ? 'complete' : ''} key={label}>{preparing.step > i ? <Check size={18} /> : i === 0 ? <Sparkles size={18} /> : i === 1 ? <LoaderCircle size={18} /> : <CheckCircle2 size={18} />}{label}</div>)}</div>{preparing.error ? <button className="primary full-width" onClick={() => void prepare(pendingInput.current)}>Try again <ArrowRight size={18} /></button> : <p className="processing-note">Finding the stream and getting picture and sound ready.</p>}</Dialog>}
    {playback && <Player key={playback.id} media={playback} close={stop} retry={position => void prepare(pendingInput.current, playback.title, position)} />}
  </div>;
}
