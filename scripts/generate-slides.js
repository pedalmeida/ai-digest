#!/usr/bin/env node
/**
 * generate-slides.js
 * Reads remixed JSON from remix-digest.js (stdin).
 * Writes a rich, scannable slide-deck HTML to ~/.follow-builders/digest-latest.html
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { process.stderr.write('generate-slides: invalid JSON\n'); process.exit(1); }

  const today = data.date || new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const slides = [{ type: 'title', date: today }];
  (data.builders || []).forEach(b => slides.push({ type: 'x', ...b }));
  (data.podcasts || []).forEach(p => slides.push({ type: 'podcast', ...p }));

  const html = renderHTML(slides, today);
  const dir = path.join(os.homedir(), '.follow-builders');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'digest-latest.html');
  fs.writeFileSync(outPath, html, 'utf8');
  process.stdout.write(outPath + '\n');
});

// ── Helpers ───────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convert **bold** markdown to <strong> tags
function richText(str) {
  return esc(str).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function ytThumb(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function avatarUrl(handle) {
  return handle ? `https://unavatar.io/twitter/${handle}` : '';
}

const SIGNAL_LABELS = {
  '🔴': 'Urgent',
  '🟡': 'Watch',
  '🟢': 'Apply now',
  '💡': 'Learn',
};

const SIGNAL_CLASSES = {
  '🔴': 'signal-red',
  '🟡': 'signal-yellow',
  '🟢': 'signal-green',
  '💡': 'signal-blue',
};

// ── Renderers ─────────────────────────────────────────────────────
function renderTitleSlide(s) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `
  <div class="slide active" data-i="0">
    <div class="title-card">
      <div class="title-card__top">
        <span class="title-badge">Daily Briefing</span>
      </div>
      <div class="title-card__body">
        <div class="title-greeting">${greeting} ☀️</div>
        <h1 class="title-headline">AI Builders<br><em>Digest</em></h1>
        <p class="title-date">${esc(s.date)}</p>
      </div>
      <div class="title-card__footer">
        <span class="title-tagline">Follow builders, not influencers</span>
        <span class="title-hint">← → to navigate</span>
      </div>
    </div>
  </div>`;
}

function renderXSlide(s, idx) {
  const avatar = avatarUrl(s.handle);
  const signal = s.signal || '🟡';
  const signalClass = SIGNAL_CLASSES[signal] || 'signal-yellow';
  const signalLabel = SIGNAL_LABELS[signal] || 'Watch';

  const insightsHTML = (s.insights || []).map(ins => `
    <li class="insight-item">
      <span class="insight-dot">◆</span>
      <span>${richText(ins)}</span>
    </li>`).join('');

  const urlsHTML = (s.urls || []).filter(Boolean).map(u => `
    <a class="source-url" href="${esc(u)}" target="_blank" rel="noopener">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.631 5.905-5.631z"/></svg>
      ${esc(u.replace('https://x.com/', '@').replace(/\/status\/\d+/, ''))}
    </a>`).join('');

  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card">

      <!-- LEFT: identity + signal -->
      <div class="card-left">
        <div class="author-block">
          ${avatar ? `<img class="author-avatar" src="${esc(avatar)}" alt="" onerror="this.style.display='none'">` : ''}
          <div class="author-text">
            <div class="author-name">${esc(s.name)}</div>
            <div class="author-role">${esc(s.role)}</div>
          </div>
        </div>
        <p class="hook-text">${richText(s.hook || '')}</p>
        <div class="card-index">${String(s.index || idx).padStart(2,'0')}</div>
      </div>

      <!-- RIGHT: insights + for you -->
      <div class="card-right">
        <div class="right-section">
          <div class="section-label">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.75 10.5h-1.5v-5h1.5v5zm0-6.5h-1.5V3.5h1.5V5z"/></svg>
            Key signals
          </div>
          <ul class="insight-list">${insightsHTML}</ul>
        </div>

        <div class="for-you-box">
          <div class="for-you-label">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            What this means for you
          </div>
          <p class="for-you-text">${richText(s.for_you || '')}</p>
        </div>

        ${urlsHTML ? `<div class="url-row">${urlsHTML}</div>` : ''}
      </div>

    </div>
  </div>`;
}

function renderPodcastSlide(s, idx) {
  const thumb = s.videoId ? ytThumb(s.videoId) : '';
  const signal = s.signal || '🟡';
  const signalClass = SIGNAL_CLASSES[signal] || 'signal-yellow';
  const signalLabel = SIGNAL_LABELS[signal] || 'Watch';

  const pointsHTML = (s.key_points || []).map(p => `
    <li class="insight-item">
      <span class="insight-dot">◆</span>
      <span>${richText(p)}</span>
    </li>`).join('');

  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card podcast-layout">

      <!-- LEFT: show info + thumbnail -->
      <div class="card-left podcast-left">
        <div class="podcast-show">${esc(s.show)}</div>
        <h2 class="podcast-episode">${esc(s.episode)}</h2>
        <div class="takeaway-box">
          <span class="takeaway-label">Takeaway</span>
          <p class="takeaway-text">${richText(s.takeaway || '')}</p>
        </div>
        ${thumb ? `
        <a class="yt-thumb-link" href="${esc(s.url)}" target="_blank" rel="noopener">
          <img class="yt-thumb" src="${esc(thumb)}" alt="Episode thumbnail">
          <div class="yt-play"><svg viewBox="0 0 24 24" fill="white" width="22" height="22"><path d="M8 5v14l11-7z"/></svg></div>
        </a>` : ''}
        <div class="card-index">${String(s.index || idx).padStart(2,'0')}</div>
      </div>

      <!-- RIGHT: key points + for you -->
      <div class="card-right">
        <div class="right-section">
          <div class="section-label">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.75 10.5h-1.5v-5h1.5v5zm0-6.5h-1.5V3.5h1.5V5z"/></svg>
            Key points
          </div>
          <ul class="insight-list">${pointsHTML}</ul>
        </div>

        <div class="for-you-box">
          <div class="for-you-label">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            What this means for you
          </div>
          <p class="for-you-text">${richText(s.for_you || '')}</p>
        </div>

        ${s.url ? `<div class="url-row"><a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">↗ Listen on YouTube</a></div>` : ''}
      </div>

    </div>
  </div>`;
}

// ── Full HTML ─────────────────────────────────────────────────────
function renderHTML(slides, today) {
  const total = slides.length;
  const slidesHTML = slides.map((s, i) => {
    if (s.type === 'title')   return renderTitleSlide(s);
    if (s.type === 'x')       return renderXSlide(s, i);
    if (s.type === 'podcast') return renderPodcastSlide(s, i);
    return '';
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Builders Digest — ${esc(today)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:          #F8F4EE;
  --surface:     #FFFFFF;
  --border:      #E8E0D4;
  --border-soft: #F0EAE0;
  --text:        #1A1410;
  --text-2:      #4A3F35;
  --muted:       #8A7B6C;
  --subtle:      #F2EDE5;

  /* Signal colors */
  --red:    #DC2626; --red-bg:    #FEF2F2; --red-border:    #FECACA;
  --yellow: #D97706; --yellow-bg: #FFFBEB; --yellow-border: #FDE68A;
  --green:  #16A34A; --green-bg:  #F0FDF4; --green-border:  #BBF7D0;
  --blue:   #2563EB; --blue-bg:   #EFF6FF; --blue-border:   #BFDBFE;

  /* Type colors */
  --x-color:   #D97706;
  --pod-color: #7C3AED;

  --shadow:    0 2px 16px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.04);
  --shadow-lg: 0 8px 40px rgba(0,0,0,0.09), 0 2px 8px rgba(0,0,0,0.05);
}

html, body {
  height: 100%; width: 100%;
  background: var(--bg);
  font-family: 'Plus Jakarta Sans', sans-serif;
  color: var(--text);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ── Deck & Slides ── */
#deck { position: relative; width: 100vw; height: 100vh; }

.slide {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  opacity: 0; pointer-events: none;
  transform: translateX(28px);
  transition: opacity 0.38s cubic-bezier(0.4,0,0.2,1), transform 0.38s cubic-bezier(0.4,0,0.2,1);
}
.slide.active  { opacity: 1; pointer-events: all; transform: translateX(0); }
.slide.leaving { opacity: 0; transform: translateX(-28px); transition-duration: 0.22s; }

/* ── Title Card ── */
.title-card {
  width: 100%; max-width: 580px;
  background: var(--surface);
  border-radius: 20px;
  box-shadow: var(--shadow-lg);
  padding: 48px 52px;
  border: 1px solid var(--border);
  position: relative; overflow: hidden;
}
.title-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #F59E0B, #EC4899, #8B5CF6, #3B82F6);
}
.title-card__top  { margin-bottom: 32px; }
.title-badge {
  font-family: 'DM Mono', monospace;
  font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--muted); background: var(--subtle); border: 1px solid var(--border);
  padding: 4px 11px; border-radius: 100px; display: inline-block;
}
.title-card__body { margin-bottom: 40px; }
.title-greeting   { font-size: 16px; font-weight: 500; color: var(--muted); margin-bottom: 12px; }
.title-headline   {
  font-family: 'Lora', serif;
  font-size: clamp(36px, 5.5vw, 58px);
  font-weight: 400; line-height: 1.1; letter-spacing: -0.02em;
  color: var(--text); margin-bottom: 16px;
}
.title-headline em { font-style: italic; color: var(--x-color); }
.title-date {
  font-family: 'DM Mono', monospace;
  font-size: 11px; color: var(--muted); letter-spacing: 0.04em;
}
.title-card__footer {
  display: flex; justify-content: space-between; align-items: center;
  border-top: 1px solid var(--border-soft); padding-top: 16px;
}
.title-tagline { font-size: 12px; color: var(--muted); font-style: italic; }
.title-hint    { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--border); }

/* ── Content Card (2-col) ── */
.content-card {
  width: 100%; max-width: 940px; height: min(600px, 88vh);
  background: var(--surface);
  border-radius: 20px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border);
  display: grid; grid-template-columns: 300px 1fr;
  overflow: hidden;
}

/* LEFT COLUMN */
.card-left {
  background: var(--subtle);
  border-right: 1px solid var(--border);
  padding: 28px 26px;
  display: flex; flex-direction: column; gap: 16px;
  position: relative; overflow: hidden;
}
.left-top {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.card-type-label {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--x-color); background: #FFFBEB; border: 1px solid #FDE68A;
  padding: 3px 9px; border-radius: 100px;
}
.card-type-pod {
  color: var(--pod-color); background: #F5F3FF; border-color: #DDD6FE;
}

/* Signal badge */
.signal-badge {
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.1em;
  padding: 3px 8px; border-radius: 100px; border: 1px solid;
  white-space: nowrap;
}
.signal-red    { color: var(--red);    background: var(--red-bg);    border-color: var(--red-border); }
.signal-yellow { color: var(--yellow); background: var(--yellow-bg); border-color: var(--yellow-border); }
.signal-green  { color: var(--green);  background: var(--green-bg);  border-color: var(--green-border); }
.signal-blue   { color: var(--blue);   background: var(--blue-bg);   border-color: var(--blue-border); }

/* Author */
.author-block { display: flex; align-items: center; gap: 10px; }
.author-avatar {
  width: 40px; height: 40px; border-radius: 50%;
  object-fit: cover; border: 2px solid var(--border); flex-shrink: 0;
}
.author-name {
  font-family: 'Lora', serif;
  font-size: clamp(16px, 1.8vw, 20px);
  font-weight: 600; color: var(--text); line-height: 1.1;
}
.author-role {
  font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4;
}

/* Hook */
.hook-text {
  font-size: clamp(13px, 1.4vw, 15px);
  line-height: 1.6; color: var(--text-2);
  font-weight: 500;
  padding: 12px 14px;
  background: var(--surface);
  border-radius: 10px;
  border-left: 3px solid var(--x-color);
}
.podcast-left .hook-text { border-left-color: var(--pod-color); }

/* Ghost index */
.card-index {
  position: absolute; bottom: -10px; right: 10px;
  font-family: 'Lora', serif; font-size: 80px; font-weight: 600;
  color: rgba(0,0,0,0.05); line-height: 1;
  user-select: none; pointer-events: none;
}

/* RIGHT COLUMN */
.card-right {
  padding: 24px 28px;
  display: flex; flex-direction: column; gap: 20px;
  overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}

.right-section { display: flex; flex-direction: column; gap: 10px; }

.section-label {
  display: flex; align-items: center; gap: 5px;
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--muted);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-soft);
}

/* Insights list */
.insight-list {
  list-style: none;
  display: flex; flex-direction: column; gap: 10px;
}
.insight-item {
  display: flex; align-items: baseline; gap: 9px;
  font-size: clamp(13px, 1.4vw, 15px);
  line-height: 1.65; color: var(--text);
}
.insight-dot {
  color: var(--x-color); font-size: 7px;
  flex-shrink: 0; margin-top: 5px;
}
.podcast-layout .insight-dot { color: var(--pod-color); }
.insight-item strong {
  background: #FEF9C3;
  padding: 0 2px; border-radius: 2px;
  font-weight: 600; color: var(--text);
}

/* For You box */
.for-you-box {
  background: linear-gradient(135deg, #EFF6FF 0%, #F0FDF4 100%);
  border: 1px solid #BFDBFE;
  border-radius: 12px;
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 6px;
}
.for-you-label {
  display: flex; align-items: center; gap: 5px;
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--blue); font-weight: 400;
}
.for-you-text {
  font-size: clamp(13px, 1.4vw, 14px);
  line-height: 1.7; color: var(--text-2);
  font-weight: 400;
}
.for-you-text strong {
  color: var(--text); font-weight: 600;
}

/* URL row */
.url-row {
  display: flex; flex-wrap: wrap; gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border-soft);
}
.source-url {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: 'DM Mono', monospace;
  font-size: 10px; color: var(--muted);
  text-decoration: none; letter-spacing: 0.02em;
  padding: 3px 8px; border-radius: 6px;
  background: var(--subtle); border: 1px solid var(--border);
  transition: color 0.15s, border-color 0.15s;
}
.source-url:hover { color: var(--blue); border-color: #BFDBFE; }

/* ── Podcast left extras ── */
.podcast-show {
  font-family: 'DM Mono', monospace;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--pod-color);
}
.podcast-episode {
  font-family: 'Lora', serif;
  font-size: clamp(14px, 1.6vw, 18px);
  font-weight: 400; line-height: 1.35; color: var(--text);
}
.takeaway-box {
  background: var(--surface);
  border-left: 3px solid var(--pod-color);
  border-radius: 0 8px 8px 0;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 4px;
}
.takeaway-label {
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--pod-color);
}
.takeaway-text {
  font-size: clamp(12px, 1.3vw, 14px);
  line-height: 1.6; color: var(--text); font-weight: 500;
}
.takeaway-text strong { background: #EDE9FE; padding: 0 2px; border-radius: 2px; }

/* YouTube thumbnail */
.yt-thumb-link {
  display: block; border-radius: 8px; overflow: hidden;
  position: relative; flex-shrink: 0;
  border: 1px solid var(--border); text-decoration: none;
}
.yt-thumb { width: 100%; height: 80px; object-fit: cover; display: block; }
.yt-play {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%,-50%);
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(0,0,0,0.65);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s;
}
.yt-thumb-link:hover .yt-play { background: #FF0000; }

/* ── Nav ── */
#nav {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; z-index: 100;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 100px; padding: 6px 14px;
  box-shadow: var(--shadow);
}
.nav-btn {
  width: 28px; height: 28px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--subtle);
  color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.18s, color 0.18s, border-color 0.18s;
}
.nav-btn:hover { background: var(--text); color: white; border-color: var(--text); }
.nav-btn svg { width: 12px; height: 12px; }
#counter {
  font-family: 'DM Mono', monospace;
  font-size: 11px; color: var(--muted); min-width: 36px; text-align: center;
}

/* ── Dots ── */
#dots {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 5px; z-index: 100;
}
.dot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--border); transition: background 0.25s, transform 0.25s; cursor: pointer;
}
.dot.active { background: var(--text); transform: scale(1.5); }

/* ── Progress ── */
#progress {
  position: fixed; top: 0; left: 0; height: 3px;
  background: linear-gradient(90deg, #F59E0B, #EC4899);
  transition: width 0.38s cubic-bezier(0.4,0,0.2,1); z-index: 200;
}

/* ── Responsive ── */
@media (max-width: 680px) {
  .content-card { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: auto; max-height: 90vh; }
  .card-left { border-right: none; border-bottom: 1px solid var(--border); }
  .card-right { max-height: 55vh; }
}
</style>
</head>
<body>

<div id="progress"></div>
<div id="dots"></div>
<div id="deck">
${slidesHTML}
</div>
<div id="nav">
  <button class="nav-btn" id="prev" aria-label="Previous">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>
  </button>
  <div id="counter">1 / ${total}</div>
  <button class="nav-btn" id="next" aria-label="Next">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
  </button>
</div>

<script>
const TOTAL = ${total};
let current = 0;
const allSlides = () => [...document.querySelectorAll('.slide')];
const allDots   = () => [...document.querySelectorAll('.dot')];

const dotsEl = document.getElementById('dots');
for (let i = 0; i < TOTAL; i++) {
  const d = document.createElement('div');
  d.className = 'dot' + (i === 0 ? ' active' : '');
  d.addEventListener('click', () => goTo(i));
  dotsEl.appendChild(d);
}

function goTo(n) {
  if (n === current || n < 0 || n >= TOTAL) return;
  const els = allSlides(), ds = allDots();
  els[current].classList.remove('active');
  els[current].classList.add('leaving');
  ds[current].classList.remove('active');
  const prev = current;
  current = n;
  requestAnimationFrame(() => {
    els[current].classList.add('active');
    ds[current].classList.add('active');
  });
  setTimeout(() => els[prev].classList.remove('leaving'), 380);
  document.getElementById('counter').textContent = (current + 1) + ' / ' + TOTAL;
  document.getElementById('progress').style.width = ((current + 1) / TOTAL * 100) + '%';
}

document.getElementById('next').addEventListener('click', () => goTo(current + 1));
document.getElementById('prev').addEventListener('click', () => goTo(current - 1));
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goTo(current + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(current - 1); }
});
let tx = 0;
document.addEventListener('touchstart', e => { tx = e.touches[0].clientX; });
document.addEventListener('touchend', e => {
  const d = tx - e.changedTouches[0].clientX;
  if (Math.abs(d) > 50) d > 0 ? goTo(current + 1) : goTo(current - 1);
});
document.getElementById('progress').style.width = (1 / TOTAL * 100) + '%';
</script>
</body>
</html>`;
}
