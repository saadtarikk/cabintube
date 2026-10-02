import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Maximize, Pause, Play, RotateCcw, Volume2, VolumeX, LoaderCircle } from 'lucide-react';
import { time, type Playback } from './api';

export default function Player({ media, close, retry }: { media: Playback; close: () => void; retry: (position: number) => void }) {
  const video = useRef<HTMLVideoElement>(null), audio = useRef<HTMLAudioElement>(null), canvas = useRef<HTMLCanvasElement>(null), root = useRef<HTMLDivElement>(null);
  const intended = useRef(true), resumeAt = useRef(media.startAt || 0), busy = useRef(false);
  const [quality, setQuality] = useState(media.qualities[0].height);
  const [playing, setPlaying] = useState(false), [buffering, setBuffering] = useState(true), [muted, setMuted] = useState(false), [position, setPosition] = useState(0), [speed, setSpeed] = useState(1), [error, setError] = useState('');
  const speedRef = useRef(speed); speedRef.current = speed;
  const duration = media.duration || video.current?.duration || 0;

  async function resume() {
    const v = video.current, a = audio.current;
    if (!v || !a || !intended.current || busy.current || v.readyState < 3 || a.readyState < 3 || v.seeking || a.seeking) return;
    busy.current = true;
    try {
      if (Math.abs(a.currentTime - v.currentTime) > .25) a.currentTime = v.currentTime;
      v.playbackRate = speedRef.current; a.playbackRate = speedRef.current;
      await Promise.all([v.play(), a.play()]);
      if (!intended.current) { v.pause(); a.pause(); return; }
      setPlaying(true); setBuffering(false);
    } catch (e) {
      v.pause(); a.pause(); setPlaying(false); setBuffering(false);
      if ((e as DOMException).name === 'NotAllowedError') { intended.current = false; }
      else if ((e as DOMException).name !== 'AbortError') setError('Playback could not start. Reconnect to try again.');
    } finally { busy.current = false; }
  }
  function wait() {
    if (!intended.current) return;
    video.current?.pause(); audio.current?.pause(); setBuffering(true);
  }
  function toggle() {
    if (playing || intended.current && buffering) {
      intended.current = false; video.current?.pause(); audio.current?.pause(); setPlaying(false); setBuffering(false);
    } else { intended.current = true; setError(''); setBuffering(true); void resume(); }
  }
  function seek(value: number) {
    if (!video.current || !audio.current) return;
    video.current.pause(); audio.current.pause();
    video.current.currentTime = value; audio.current.currentTime = value; setPosition(value);
    setBuffering(intended.current);
  }
  useEffect(() => {
    const v = video.current!, c = canvas.current!, context = c.getContext('2d');
    let frame = 0, disposed = false;
    const hasFrameCallback = typeof v.requestVideoFrameCallback === 'function';
    const draw = () => {
      if (disposed) return;
      if (v.readyState >= 2 && v.videoWidth) {
        if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
        context?.drawImage(v, 0, 0, c.width, c.height);
      }
      frame = hasFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    draw();
    const tick = setInterval(() => {
      const a = audio.current;
      if (!a) return;
      setPosition(v.currentTime);
      if (v.ended) { intended.current = false; a.pause(); setPlaying(false); setBuffering(false); }
      else if (intended.current && v.readyState >= 3 && a.readyState >= 3 && (v.paused || a.paused)) void resume();
      if (!v.paused && !a.paused && !v.seeking && !a.seeking) {
        const drift = v.currentTime - a.currentTime;
        if (Math.abs(drift) > .3) a.currentTime = v.currentTime;
        else a.playbackRate = speedRef.current * (Math.abs(drift) > .06 ? drift > 0 ? 1.03 : .97 : 1);
      }
    }, 150);
    return () => { disposed = true; clearInterval(tick); hasFrameCallback ? v.cancelVideoFrameCallback(frame) : cancelAnimationFrame(frame); v.pause(); audio.current?.pause(); };
  }, []);
  useEffect(() => { if (video.current) video.current.playbackRate = speed; if (audio.current) audio.current.playbackRate = speed; }, [speed]);
  useEffect(() => {
    const delay = Math.max(1000, media.expiresAt - Date.now() - 30_000);
    const timer = setTimeout(() => retry(video.current?.currentTime || 0), delay);
    return () => clearTimeout(timer);
  }, [media.expiresAt, retry]);
  function changeQuality(height: number) { resumeAt.current = video.current?.currentTime || 0; video.current?.pause(); audio.current?.pause(); setBuffering(intended.current); setQuality(height); }
  function failed() { intended.current = false; video.current?.pause(); audio.current?.pause(); setPlaying(false); setBuffering(false); setError('The stream connection was interrupted. Reconnect to continue.'); }

  return <div className="player" ref={root} role="dialog" aria-modal="true" aria-label="Video player">
    <video ref={video} className="media-engine" muted playsInline preload="auto" src={media.qualities.find(q => q.height === quality)!.url}
      onLoadedMetadata={() => { if (video.current && resumeAt.current) { video.current.currentTime = resumeAt.current; if (audio.current) audio.current.currentTime = resumeAt.current; resumeAt.current = 0; } }}
      onCanPlay={() => void resume()} onSeeked={() => void resume()} onWaiting={wait} onError={failed} />
    <audio ref={audio} src={media.audio} preload="auto" muted={muted} onCanPlay={() => void resume()} onSeeked={() => void resume()} onWaiting={wait} onError={failed} />
    <canvas ref={canvas} width={1280} height={720} className="picture" aria-label={media.title} onClick={toggle} />
    <button className="player-back glass" onClick={close}><ArrowLeft size={22} /> Back</button>
    <span className="player-quality glass">{quality}p <span className="status-dot" /> STREAM</span>
    {buffering && !error && <div className="player-status"><LoaderCircle className="spin" size={30} /><span>Buffering</span></div>}
    {error && <div className="player-error glass" role="alert"><p>{error}</p><button className="primary" onClick={() => retry(video.current?.currentTime || position)}><RotateCcw size={18} /> Reconnect</button></div>}
    {!playing && !buffering && !error && <button className="big-play" onClick={toggle} aria-label="Play video"><Play size={36} fill="currentColor" /></button>}
    <div className="player-bottom">
      <input className="timeline" type="range" min={0} max={Number.isFinite(duration) ? duration : 0} step={.1} value={position} onChange={e => seek(Number(e.target.value))} aria-label="Seek video" style={{ '--progress': `${duration ? position / duration * 100 : 0}%` } as React.CSSProperties} />
      <div className="transport glass">
        <div className="transport-left"><span className="time">{time(position)} <span>/ {time(duration)}</span></span><button className="icon-button" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? <VolumeX size={21} /> : <Volume2 size={21} />}</button></div>
        <button className="play-button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause fill="currentColor" size={24} /> : <Play fill="currentColor" size={24} />}</button>
        <div className="transport-right"><select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[.5, 1, 1.25, 1.5, 2].map(s => <option key={s} value={s}>{s}×</option>)}</select><select aria-label="Video quality" value={quality} onChange={e => changeQuality(Number(e.target.value))}>{media.qualities.map(q => <option key={q.height} value={q.height}>{q.height}p</option>)}</select><button className="icon-button fullscreen-button" onClick={() => void root.current?.requestFullscreen().catch(() => {})} aria-label="Fullscreen"><Maximize size={20} /></button></div>
      </div>
      <div className="player-title glass">{media.title}</div>
    </div>
  </div>;
}
