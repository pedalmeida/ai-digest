#!/usr/bin/env node
/**
 * generate-slides.js
 * Reads prepare-digest.js JSON from stdin, writes a self-contained
 * slide-deck HTML to ~/.follow-builders/digest-latest.html
 * Prints the output file path to stdout.
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

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // ── Build slide data ──────────────────────────────────────────────
  const slides = [{ type: 'title', date: today }];

  const xBuilders = data.x || [];
  xBuilders.forEach((builder, i) => {
    const tweets = (builder.tweets || []).filter(t => t.text && t.text.trim().length > 15);
    if (!tweets.length) return;

    const bio = (builder.bio || '').split('\n')[0].replace(/\s+/g, ' ').trim();

    const cleanText = t =>
      t.text
        .replace(/https?:\/\/t\.co\/\S+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const firstUrl = tweets[0].url || '';
    const handle = (firstUrl.match(/x\.com\/([^/]+)\/status/) || [])[1] || '';

    // Keep each tweet as its own item for rich display
    const tweetItems = tweets.slice(0, 3).map(t => ({
      text: cleanText(t),
      url:  t.url || ''
    })).filter(t => t.text.length > 10);

    slides.push({
      type:   'x',
      name:   builder.name || builder.handle,
      role:   bio,
      tweets: tweetItems,
      handle,
      index:  i + 1
    });
  });

  (data.podcasts || []).forEach((pod, i) => {
    const videoId = (pod.url || '').match(/(?:v=|watch\?v=|youtu\.be\/)([^&\s]+)/)?.[1] || '';
    slides.push({
      type:    'podcast',
      show:    pod.name,
      episode: pod.title,
      url:     pod.url,
      videoId,
      index:   xBuilders.length + i + 1
    });
  });

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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ytThumb(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

function avatarUrl(handle) {
  return handle ? `https://unavatar.io/twitter/${handle}` : '';
}

// ── Slide renderers ───────────────────────────────────────────────
function renderTitleSlide(s) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `
  <div class="slide active" data-i="0">
    <div class="title-card">
      <div class="title-top">
        <div class="title-badge">Daily Briefing</div>
      </div>
      <div class="title-body">
        <div class="title-greeting">${greeting} ☀️</div>
        <h1 class="title-headline">AI Builders<br><em>Digest</em></h1>
        <p class="title-date">${esc(s.date)}</p>
      </div>
      <div class="title-footer">
        <span class="title-tagline">Follow builders, not influencers</span>
        <span class="title-hint">← → to navigate</span>
      </div>
    </div>
  </div>`;
}

function renderXSlide(s, idx) {
  const avatar = avatarUrl(s.handle);
  const tweetsHTML = (s.tweets || []).map((t, i) => `
    <div class="tweet-item${i > 0 ? ' tweet-item--sep' : ''}">
      <div class="tweet-bubble">
        <p class="tweet-text">${esc(t.text)}</p>
      </div>
      ${t.url ? `<a class="tweet-link" href="${esc(t.url)}" target="_blank" rel="noopener">↗ View on X</a>` : ''}
    </div>`).join('');

  return `
  <div class="slide" data-i="${idx}">
    <div class="x-card">
      <div class="x-card-header">
        <div class="card-tag tag-x">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.259 5.631 5.905-5.631zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          X / Twitter
        </div>
        <div class="x-card-author">
          ${avatar ? `<img class="author-avatar" src="${esc(avatar)}" alt="${esc(s.name)}" onerror="this.style.display='none'">` : ''}
          <div>
            <div class="author-name">${esc(s.name)}</div>
            <div class="author-role">${esc(s.role)}</div>
          </div>
        </div>
        <div class="card-index">${String(s.index).padStart(2,'0')}</div>
      </div>
      <div class="tweet-list">
        ${tweetsHTML}
      </div>
    </div>
  </div>`;
}

function renderPodcastSlide(s, idx) {
  const thumb = s.videoId ? ytThumb(s.videoId) : '';
  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card podcast-card">
      <div class="card-left">
        <div class="card-tag tag-podcast">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
          Podcast
        </div>
        <div class="podcast-show">${esc(s.show)}</div>
        <h2 class="podcast-episode">${esc(s.episode)}</h2>
        ${s.url ? `<a class="card-link" href="${esc(s.url)}" target="_blank" rel="noopener">Listen now →</a>` : ''}
        <div class="card-index">${String(s.index).padStart(2,'0')}</div>
      </div>
      <div class="card-right">
        ${thumb ? `
        <a class="yt-wrap" href="${esc(s.url)}" target="_blank" rel="noopener">
          <img class="yt-thumb" src="${esc(thumb)}" alt="Episode thumbnail" loading="lazy">
          <div class="yt-play">
            <svg viewBox="0 0 24 24" fill="white" width="28" height="28"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </a>` : ''}
      </div>
    </div>
  </div>`;
}

// ── Full HTML page ────────────────────────────────────────────────
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
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400;1,600&family=Plus+Jakarta+Sans:wght@300;400;500;600&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet">

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #FDF8F2;
  --surface:   #FFFFFF;
  --border:    #EDE5D8;
  --text:      #1C1712;
  --muted:     #8C7E6B;
  --subtle:    #F5F0E8;
  --x-color:   #D97706;
  --x-bg:      #FEF3C7;
  --x-border:  #FDE68A;
  --pod-color: #7C3AED;
  --pod-bg:    #EDE9FE;
  --pod-border:#DDD6FE;
  --link:      #2563EB;
  --shadow:    0 4px 24px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04);
  --shadow-lg: 0 8px 40px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.05);
}

html, body {
  height: 100%; width: 100%;
  background: var(--bg);
  font-family: 'Plus Jakarta Sans', sans-serif;
  color: var(--text);
  overflow: hidden;
}

/* ── Deck ── */
#deck { position: relative; width: 100vw; height: 100vh; }

/* ── Slides ── */
.slide {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  opacity: 0; pointer-events: none;
  transform: translateX(36px);
  transition: opacity 0.4s cubic-bezier(0.4,0,0.2,1), transform 0.4s cubic-bezier(0.4,0,0.2,1);
}
.slide.active  { opacity: 1; pointer-events: all; transform: translateX(0); }
.slide.leaving { opacity: 0; transform: translateX(-36px); transition-duration: 0.25s; }

/* ── Title card ── */
.title-card {
  width: 100%; max-width: 620px;
  background: var(--surface);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
  padding: 52px 56px;
  border: 1px solid var(--border);
  position: relative; overflow: hidden;
}
.title-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: linear-gradient(90deg, #F59E0B, #EC4899, #8B5CF6, #3B82F6);
}
.title-top { margin-bottom: 36px; }
.title-badge {
  display: inline-block;
  font-family: 'DM Mono', monospace;
  font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--muted);
  background: var(--bg); border: 1px solid var(--border);
  padding: 5px 12px; border-radius: 100px;
}
.title-body { margin-bottom: 44px; }
.title-greeting { font-size: 17px; font-weight: 500; color: var(--muted); margin-bottom: 14px; }
.title-headline {
  font-family: 'Lora', serif;
  font-size: clamp(38px, 6vw, 60px);
  font-weight: 400; line-height: 1.1; letter-spacing: -0.02em;
  color: var(--text); margin-bottom: 18px;
}
.title-headline em { font-style: italic; color: var(--x-color); }
.title-date { font-family: 'DM Mono', monospace; font-size: 12px; color: var(--muted); }
.title-footer {
  display: flex; justify-content: space-between; align-items: center;
  border-top: 1px solid var(--border); padding-top: 18px;
}
.title-tagline { font-size: 13px; color: var(--muted); font-style: italic; }
.title-hint { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--border); }

/* ── Shared tag pill ── */
.card-tag {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: 'DM Mono', monospace;
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  padding: 4px 11px; border-radius: 100px; border: 1px solid;
  width: fit-content;
}
.tag-x       { color: var(--x-color);   background: var(--x-bg);   border-color: var(--x-border); }
.tag-podcast { color: var(--pod-color); background: var(--pod-bg); border-color: var(--pod-border); }

/* ── X card — full width, rich layout ── */
.x-card {
  width: 100%; max-width: 780px; max-height: 86vh;
  background: var(--surface);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border);
  display: flex; flex-direction: column;
  overflow: hidden;
}

/* Header bar */
.x-card-header {
  display: flex; align-items: center; gap: 16px;
  padding: 24px 36px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--subtle);
  position: relative;
}
.x-card-author {
  display: flex; align-items: center; gap: 12px;
  flex: 1;
}
.author-avatar {
  width: 44px; height: 44px; border-radius: 50%;
  object-fit: cover; border: 2px solid var(--border);
  flex-shrink: 0;
}
.author-name {
  font-family: 'Lora', serif;
  font-size: clamp(18px, 2vw, 22px);
  font-weight: 600; color: var(--text); line-height: 1.1;
}
.author-role {
  font-size: 12px; color: var(--muted); margin-top: 2px;
  line-height: 1.4; max-width: 420px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-index {
  font-family: 'Lora', serif;
  font-size: 42px; font-weight: 600;
  color: rgba(0,0,0,0.06);
  line-height: 1; user-select: none;
  flex-shrink: 0;
}

/* Tweet list */
.tweet-list {
  flex: 1;
  padding: 0 36px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.tweet-item {
  padding: 22px 0;
  display: flex; flex-direction: column; gap: 10px;
}
.tweet-item--sep { border-top: 1px solid var(--border); }

/* Tweet bubble */
.tweet-bubble {
  background: var(--subtle);
  border-radius: 12px;
  border-left: 3px solid var(--x-color);
  padding: 14px 18px;
}
.tweet-text {
  font-size: clamp(14px, 1.55vw, 17px);
  line-height: 1.7; color: var(--text);
  font-weight: 400;
}
.tweet-link {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600;
  color: var(--link); text-decoration: none;
  font-family: 'DM Mono', monospace;
  letter-spacing: 0.02em;
  padding: 0 2px;
}
.tweet-link:hover { text-decoration: underline; }

/* ── Podcast card — two column ── */
.content-card {
  width: 100%; max-width: 860px; height: min(540px, 82vh);
  background: var(--surface);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border);
  display: grid; grid-template-columns: 1fr 1fr;
  overflow: hidden;
}
.card-left {
  padding: 40px 44px;
  display: flex; flex-direction: column; justify-content: center;
  border-right: 1px solid var(--border);
  position: relative; gap: 0;
}
.card-left .card-tag { margin-bottom: 20px; }
.card-link {
  display: inline-block; margin-top: 24px;
  font-size: 13px; font-weight: 600;
  color: var(--link); text-decoration: none;
}
.card-link:hover { text-decoration: underline; }
.card-left .card-index {
  position: absolute; bottom: -6px; right: 16px;
  font-size: 80px; color: rgba(0,0,0,0.04);
}
.podcast-show {
  font-family: 'DM Mono', monospace;
  font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--pod-color); margin-bottom: 12px;
}
.podcast-episode {
  font-family: 'Lora', serif;
  font-size: clamp(17px, 2vw, 24px);
  font-weight: 400; line-height: 1.35; color: var(--text);
  margin-bottom: 0;
}
.card-right {
  position: relative; background: var(--subtle);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}

/* YouTube thumbnail */
.yt-wrap {
  display: block; width: 100%; height: 100%;
  position: relative; text-decoration: none;
}
.yt-thumb {
  width: 100%; height: 100%;
  object-fit: cover; object-position: center;
  display: block;
}
.yt-play {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 52px; height: 52px; border-radius: 50%;
  background: rgba(0,0,0,0.65);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s, transform 0.2s;
}
.yt-wrap:hover .yt-play { background: #FF0000; transform: translate(-50%, -50%) scale(1.1); }

/* ── Nav pill ── */
#nav {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; z-index: 100;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 100px; padding: 7px 16px;
  box-shadow: var(--shadow);
}
.nav-btn {
  width: 30px; height: 30px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
}
.nav-btn:hover { background: var(--text); color: white; border-color: var(--text); }
.nav-btn svg { width: 13px; height: 13px; }
#counter {
  font-family: 'DM Mono', monospace;
  font-size: 11px; color: var(--muted); min-width: 36px; text-align: center;
}

/* ── Dots ── */
#dots {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 5px; z-index: 100;
}
.dot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--border); transition: background 0.3s, transform 0.3s;
  cursor: pointer;
}
.dot.active { background: var(--text); transform: scale(1.4); }

/* ── Progress bar ── */
#progress {
  position: fixed; top: 0; left: 0; height: 3px;
  background: linear-gradient(90deg, #F59E0B, #EC4899);
  transition: width 0.4s cubic-bezier(0.4,0,0.2,1);
  z-index: 200;
}

@media (max-width: 640px) {
  .content-card { grid-template-columns: 1fr; height: auto; max-height: 86vh; }
  .card-left { border-right: none; border-bottom: 1px solid var(--border); padding: 28px; }
  .card-right { min-height: 180px; }
  .x-card-header { padding: 18px 20px 16px; }
  .tweet-list { padding: 0 20px; }
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
  </button>
  <div id="counter">1 / ${total}</div>
  <button class="nav-btn" id="next" aria-label="Next">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </button>
</div>

<script>
const TOTAL = ${total};
let current = 0;
const slides = () => [...document.querySelectorAll('.slide')];
const dots   = () => [...document.querySelectorAll('.dot')];

// Build dots
const dotsEl = document.getElementById('dots');
for (let i = 0; i < TOTAL; i++) {
  const d = document.createElement('div');
  d.className = 'dot' + (i === 0 ? ' active' : '');
  d.addEventListener('click', () => goTo(i));
  dotsEl.appendChild(d);
}

function goTo(n, dir) {
  if (n === current) return;
  const els = slides();
  const ds  = dots();
  els[current].classList.remove('active');
  els[current].classList.add('leaving');
  setTimeout(() => els[current < n ? current : n + (n < current ? 0 : 0)].classList.remove('leaving'), 350);
  ds[current].classList.remove('active');
  current = Math.max(0, Math.min(n, TOTAL - 1));
  // small delay to allow leaving animation to start
  requestAnimationFrame(() => {
    els[current].classList.add('active');
    ds[current].classList.add('active');
  });
  document.getElementById('counter').textContent = (current + 1) + ' / ' + TOTAL;
  document.getElementById('progress').style.width = ((current + 1) / TOTAL * 100) + '%';
  // clean up leaving after transition
  setTimeout(() => {
    slides().forEach(s => { if (!s.classList.contains('active')) s.classList.remove('leaving'); });
  }, 500);
}

function next() { if (current < TOTAL - 1) goTo(current + 1); }
function prev() { if (current > 0) goTo(current - 1); }

document.getElementById('next').addEventListener('click', next);
document.getElementById('prev').addEventListener('click', prev);
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
  if (e.key === 'ArrowLeft')                    { e.preventDefault(); prev(); }
});
let tx = 0;
document.addEventListener('touchstart', e => { tx = e.touches[0].clientX; });
document.addEventListener('touchend',   e => {
  const d = tx - e.changedTouches[0].clientX;
  if (Math.abs(d) > 50) d > 0 ? next() : prev();
});

// Init progress
document.getElementById('progress').style.width = (1 / TOTAL * 100) + '%';

</script>
</body>
</html>`;
}
