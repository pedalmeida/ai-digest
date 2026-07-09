#!/usr/bin/env node
/**
 * generate-slides.js
 * Reads digest-draft.json from repo root (written by remix-digest.js).
 * Writes a two-layer reading experience to index.html:
 *   - Slide 0: an intro/overview screen — health, since-yesterday, and every
 *     item as a tappable one-line headline grouped by section.
 *   - Slides 1..N: the full slide deck, one card per item, swipe/arrow nav.
 * Tapping a headline on the intro jumps straight into the deck at that card.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAFT_PATH = path.join(__dirname, '..', 'digest-draft.json');
const OUT_PATH   = path.join(__dirname, '..', 'index.html');

if (!fs.existsSync(DRAFT_PATH)) {
  process.stderr.write(`generate-slides: digest-draft.json not found at ${DRAFT_PATH}\n`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));

const today = data.date || new Date().toLocaleDateString('en-GB', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
});

const SIGNAL_LABELS  = { '🔴': 'Urgent', '🟡': 'Watch', '🟢': 'Apply now', '💡': 'Learn' };
const SIGNAL_CLASSES = { '🔴': 'signal-red', '🟡': 'signal-yellow', '🟢': 'signal-green', '💡': 'signal-blue' };

// The model may return "🟢 apply now" combined text or just the emoji —
// normalize to the emoji so labels never render twice.
function normalizeSignal(raw) {
  const emoji = (String(raw || '').match(/[\u{1F534}\u{1F7E1}\u{1F7E2}\u{1F4A1}]/u) || ['🟡'])[0];
  return emoji;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function richText(str) {
  return esc(str).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Lazy YouTube Shorts embed: no iframe src until the slide becomes active
// (see the goTo() JS below), so only the visible card's video ever plays.
// data-yt-id is read by the nav script; muted+playsinline is required for
// autoplay to actually fire in mobile browsers.
function videoBlockHTML(video) {
  if (!video?.id) return '';
  return `
    <div class="card-video" data-yt-id="${esc(video.id)}">
      <div class="card-video-frame"></div>
      <a class="card-video-open" href="https://youtube.com/shorts/${esc(video.id)}" target="_blank" rel="noopener" title="Open on YouTube">↗</a>
    </div>`;
}

function staticImageHTML(image, alt) {
  if (!image) return '';
  return `<div class="card-media"><img class="card-media-img" src="${esc(image)}" alt="${esc(alt || '')}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`;
}

// A story can have both a matched Short AND a static article image — show
// the video as the primary media (autoplay), the image as a small secondary
// thumbnail beneath it so nothing found gets thrown away.
function mediaBlockHTML(s, videoAspect) {
  const video = videoBlockHTML(s.video);
  if (video && s.image) {
    return `${video}<div class="card-media-secondary"><img class="card-media-secondary-img" src="${esc(s.image)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`;
  }
  if (video) return video;
  if (s.image) return staticImageHTML(s.image, s.hook || s.headline || '');
  return '';
}

function ytThumb(url) {
  const id = (url || '').match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1];
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : '';
}

function avatarUrl(handle) {
  return handle ? `https://unavatar.io/twitter/${handle}` : '';
}

// ── Build slide list ──────────────────────────────────────────────
// slide 0 is the intro; real content slides start at index 1.
const slides = [{ type: 'intro' }];

const SECTIONS = [
  { key: 'ai',         label: 'AI & Building',       emoji: '🤖', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', kind: 'ai' },
  { key: 'build_this',  label: 'Build This Week',     emoji: '🛠️', color: '#16A34A', bg: '#F0FDF4', border: '#BBF7D0', kind: 'build' },
  { key: 'podcasts',    label: 'Podcasts',            emoji: '🎙️', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', kind: 'podcast' },
  { key: 'tech',        label: 'Tech',                emoji: '⚙️', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', kind: 'tech' },
  { key: 'pt_news',     label: 'PT News',             emoji: '🇵🇹', color: '#006400', bg: '#F0FDF4', border: '#BBF7D0', kind: 'news' },
  { key: 'world_news',  label: 'World News',          emoji: '🌍', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE', kind: 'news' },
];

// Track intro entries as we go: {sectionLabel, sectionEmoji, headline, signal, slideIndex}
const introEntries = [];

for (const sec of SECTIONS) {
  const items = data[sec.key] || [];
  if (items.length === 0) continue;

  slides.push({ type: 'section', label: sec.label, emoji: sec.emoji, color: sec.color, bg: sec.bg, border: sec.border });

  for (const item of items) {
    const slideIndex = slides.length;
    introEntries.push({
      sectionLabel: sec.label,
      sectionEmoji: sec.emoji,
      color: sec.color,
      kind: sec.kind,
      title: introTitle(item, sec.kind),
      summary: introSummary(item, sec.kind),
      thumb: introThumb(item, sec.kind),
      source: introSource(item, sec.kind),
      url: introUrl(item, sec.kind),
      signal: normalizeSignal(item.signal),
      slideIndex,
    });
    slides.push({ type: sec.kind, ...item });
  }
}

// ── Intro card content extraction (per item kind) ────────────────────
function introTitle(item, kind) {
  if (kind === 'ai' || kind === 'tech') return item.hook || item.name || '';
  if (kind === 'build') return item.what_it_is ? item.name : (item.name || '');
  if (kind === 'podcast') return item.episode || item.show || '';
  return item.headline || item.hook || ''; // news
}

function introSummary(item, kind) {
  if (kind === 'ai' || kind === 'tech') return (item.insights || [])[0] || item.key_point || '';
  if (kind === 'build') return item.what_it_is || '';
  if (kind === 'podcast') return item.takeaway || (item.key_points || [])[0] || '';
  return item.hook || ''; // news — headline is the title, hook is the summary
}

// Who this item actually came from — shown on every overview card so the
// source is visible without opening the deck.
function introSource(item, kind) {
  if (kind === 'ai' || kind === 'tech') return item.name || (item.handle ? `@${item.handle}` : '');
  if (kind === 'build') return item.source || '';
  if (kind === 'podcast') return item.show || '';
  return item.source_name || ''; // news
}

// The single original URL to link out to, per item kind.
function introUrl(item, kind) {
  if (kind === 'ai' || kind === 'tech') return (item.urls || [])[0] || '';
  return item.url || '';
}

// Thumbnail priority is the same for every kind: a matched Short beats a
// real article/og image, which beats an X avatar, which beats a generic
// icon. The generic icon is the last resort, never the default.
function introThumb(item, kind) {
  const shortThumb = item.video?.id ? `https://img.youtube.com/vi/${item.video.id}/hqdefault.jpg` : '';
  if (shortThumb) return { type: 'image', src: shortThumb, fallback: kind === 'podcast' ? '🎙️' : '📰' };

  if (kind === 'podcast') return { type: 'image', src: ytThumb(item.url), fallback: '🎙️' };
  if (item.image) return { type: 'image', src: item.image, fallback: kind === 'build' ? '🛠️' : '📰' };

  if (kind === 'ai' || kind === 'tech') {
    const avatar = avatarUrl(item.handle);
    if (avatar) return { type: 'avatar', src: avatar, fallback: '🤖' };
    return { type: 'emoji', fallback: '🤖' };
  }
  if (kind === 'build') return { type: 'emoji', fallback: '🛠️' };
  return { type: 'emoji', fallback: '📰' };
}

const html = renderHTML(slides, introEntries, today);
fs.writeFileSync(OUT_PATH, html, 'utf8');
process.stdout.write(`generate-slides: wrote ${slides.length} slides (1 intro + ${slides.length - 1} cards) to ${OUT_PATH}\n`);

// ── Intro slide ─────────────────────────────────────────────────────
function renderHealthBanner(health) {
  if (!health) return '';
  const labels = { x: 'X/Twitter', podcasts: 'Podcasts', rss: 'RSS', hackernews: 'Hacker News', github_trending: 'GitHub Trending' };
  const rows = Object.entries(health)
    .filter(([, v]) => v.attempted > 0)
    .map(([key, v]) => {
      const label = labels[key] || key;
      const degraded = v.ok / v.attempted < 0.5;
      return `<span class="health-item${degraded ? ' health-bad' : ''}">${esc(label)} ${v.ok}/${v.attempted}</span>`;
    }).join('');
  return rows ? `<details class="health-banner"><summary>Source health</summary><div class="health-rows">${rows}</div></details>` : '';
}

function renderIntroSlide(introEntries, today) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const sinceYesterday = data.since_yesterday ? `
    <div class="since-yesterday">
      <span class="since-label">Since yesterday</span>
      <p>${richText(data.since_yesterday)}</p>
    </div>` : '';

  // Group intro entries by section, preserving section order of first appearance.
  const groups = [];
  for (const entry of introEntries) {
    let group = groups.find(g => g.label === entry.sectionLabel);
    if (!group) {
      group = { label: entry.sectionLabel, emoji: entry.sectionEmoji, color: entry.color, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }

  const groupsHTML = groups.map(g => `
    <div class="intro-group">
      <div class="intro-group-label" style="color:${g.color}">${g.emoji} ${esc(g.label)}</div>
      ${g.entries.map(e => renderIntroItem(e)).join('')}
    </div>`).join('');

  const legend = `
    <div class="signal-legend">
      <span class="legend-item"><span class="legend-dot signal-green"></span>Apply now</span>
      <span class="legend-item"><span class="legend-dot signal-yellow"></span>Watch</span>
      <span class="legend-item"><span class="legend-dot signal-red"></span>Urgent</span>
      <span class="legend-item"><span class="legend-dot signal-blue"></span>Learn</span>
    </div>`;

  return `
  <div class="slide active" data-i="0">
    <div class="intro-card">
      <div class="intro-top">
        <span class="title-badge">Daily Briefing</span>
        ${renderHealthBanner(data.health)}
      </div>
      <div class="intro-greeting">${greeting} ☀️</div>
      <h1 class="intro-headline">Daily<br><em>Digest</em></h1>
      <p class="intro-date">${esc(today)}</p>
      ${sinceYesterday}
      ${legend}
      <div class="intro-list">${groupsHTML}</div>
      <button class="intro-start" data-goto="1">Start from the top ↓</button>
    </div>
  </div>`;
}

function renderIntroItem(e) {
  const t = e.thumb;
  let thumbHTML;
  if (t.type === 'avatar' && t.src) {
    thumbHTML = `<img class="intro-thumb intro-thumb-round" src="${esc(t.src)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;intro-thumb intro-thumb-fallback&quot;>${t.fallback}</div>'">`;
  } else if (t.type === 'image' && t.src) {
    thumbHTML = `<img class="intro-thumb" src="${esc(t.src)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;intro-thumb intro-thumb-fallback&quot;>${t.fallback}</div>'">`;
  } else {
    thumbHTML = `<div class="intro-thumb intro-thumb-fallback">${t.fallback}</div>`;
  }

  const cls = { '🔴': 'signal-red', '🟡': 'signal-yellow', '🟢': 'signal-green', '💡': 'signal-blue' }[e.signal] || 'signal-yellow';

  const sourceLink = e.url
    ? `<a class="intro-item-source" href="${esc(e.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ ${esc(e.source || 'Source')}</a>`
    : (e.source ? `<span class="intro-item-source intro-item-source-plain">${esc(e.source)}</span>` : '');

  return `
    <div class="intro-item">
      <button class="intro-item-body" data-goto="${e.slideIndex}">
        <span class="intro-thumb-wrap"><span class="intro-signal-dot ${cls}"></span>${thumbHTML}</span>
        <span class="intro-item-text">
          <span class="intro-item-title">${richText(e.title)}</span>
          ${e.summary ? `<span class="intro-item-summary">${richText(e.summary)}</span>` : ''}
          ${sourceLink}
        </span>
        <span class="intro-item-arrow">→</span>
      </button>
    </div>`;
}

// ── Section divider slide ────────────────────────────────────────────
function renderSectionSlide(s, idx) {
  return `
  <div class="slide" data-i="${idx}">
    <div class="section-card" style="--sec-color:${s.color};--sec-bg:${s.bg};--sec-border:${s.border}">
      <div class="section-card__inner">
        <div class="section-emoji">${s.emoji}</div>
        <div class="section-chapter">Chapter</div>
        <h2 class="section-title">${esc(s.label)}</h2>
        <div class="section-rule"></div>
      </div>
    </div>
  </div>`;
}

function signalBadgeHTML(signal) {
  const s = normalizeSignal(signal);
  const cls = SIGNAL_CLASSES[s] || 'signal-yellow';
  const label = SIGNAL_LABELS[s] || 'Watch';
  return `<span class="signal-badge ${cls}">${s} ${esc(label)}</span>`;
}

// ── AI / Tech card (X builder, RSS source, or general AI item) ──────
function renderAiSlide(s, idx) {
  const avatar = avatarUrl(s.handle);
  const insightsHTML = (s.insights || []).map(ins => `
    <li class="insight-item"><span class="insight-dot">◆</span><span>${richText(ins)}</span></li>`).join('');
  const urlsHTML = (s.urls || []).filter(Boolean).map(u => `
    <a class="source-url" href="${esc(u)}" target="_blank" rel="noopener">↗ ${esc(u.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 42))}</a>`).join('');

  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card">
      <div class="card-left">
        ${mediaBlockHTML(s)}
        <div class="author-block">
          ${avatar ? `<img class="author-avatar" src="${esc(avatar)}" alt="" onerror="this.style.display='none'">` : ''}
          <div class="author-text">
            <div class="author-name">${esc(s.name)}</div>
            <div class="author-role">${esc(s.role)}</div>
          </div>
        </div>
        <p class="hook-text">${richText(s.hook || '')}</p>
        ${signalBadgeHTML(s.signal)}
        <div class="card-index">${String(idx).padStart(2,'0')}</div>
      </div>
      <div class="card-right">
        ${insightsHTML ? `
        <div class="right-section">
          <div class="section-label">Key signals</div>
          <ul class="insight-list">${insightsHTML}</ul>
        </div>` : ''}
        <div class="for-you-box">
          <div class="for-you-label">What this means for you</div>
          <p class="for-you-text">${richText(s.for_you || '')}</p>
        </div>
        ${s.why_it_made_the_cut ? `<p class="why-cut">Why this made the cut: ${esc(s.why_it_made_the_cut)}</p>` : ''}
        ${urlsHTML ? `<div class="url-row">${urlsHTML}</div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── Build This Week card ─────────────────────────────────────────────
function renderBuildSlide(s, idx) {
  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card">
      <div class="card-left">
        <div class="author-block">
          <div class="build-icon">🛠️</div>
          <div class="author-text">
            <div class="author-name">${esc(s.name)}</div>
            <div class="author-role">${esc(s.source)}</div>
          </div>
        </div>
        <p class="hook-text">${richText(s.what_it_is || '')}</p>
        <div class="card-index">${String(idx).padStart(2,'0')}</div>
      </div>
      <div class="card-right">
        <div class="for-you-box">
          <div class="for-you-label">Try this</div>
          <p class="for-you-text">${richText(s.why_try_it || '')}</p>
        </div>
        ${s.url ? `<div class="url-row"><a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">↗ Open link</a></div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── Podcast card ───────────────────────────────────────────────────
function renderPodcastSlide(s, idx) {
  const thumb = ytThumb(s.url);
  const pointsHTML = (s.key_points || []).map(p => `
    <li class="insight-item"><span class="insight-dot">◆</span><span>${richText(p)}</span></li>`).join('');

  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card podcast-layout">
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
        <div class="card-index">${String(idx).padStart(2,'0')}</div>
      </div>
      <div class="card-right">
        ${pointsHTML ? `
        <div class="right-section">
          <div class="section-label">Key points</div>
          <ul class="insight-list">${pointsHTML}</ul>
        </div>` : ''}
        <div class="for-you-box">
          <div class="for-you-label">What this means for you</div>
          <p class="for-you-text">${richText(s.for_you || '')}</p>
        </div>
        ${s.url ? `<div class="url-row"><a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">↗ Watch/listen</a></div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── News card (PT / World) ──────────────────────────────────────────
function renderNewsSlide(s, idx, sectionColor) {
  const media = mediaBlockHTML(s);

  return `
  <div class="slide" data-i="${idx}">
    <div class="content-card news-layout" style="--sec-color:${sectionColor}">
      <div class="card-left news-left">
        ${media}
        <div class="news-source-tag">${esc(s.source_name || '')}</div>
        <h2 class="news-headline">${richText(s.headline || s.hook || '')}</h2>
        <p class="hook-text news-hook">${richText(s.hook || '')}</p>
        <div class="card-index">${String(idx).padStart(2,'0')}</div>
      </div>
      <div class="card-right">
        <div class="for-you-box">
          <div class="for-you-label">What this means for you</div>
          <p class="for-you-text">${richText(s.for_you || '')}</p>
        </div>
        ${signalBadgeHTML(s.signal)}
        ${s.url ? `<div class="url-row"><a class="source-url" href="${esc(s.url)}" target="_blank" rel="noopener">↗ Read article</a></div>` : ''}
      </div>
    </div>
  </div>`;
}

// ── Full HTML ─────────────────────────────────────────────────────
function renderHTML(slides, introEntries, today) {
  const total = slides.length;
  const slidesHTML = slides.map((s, i) => {
    if (s.type === 'intro')   return renderIntroSlide(introEntries, today);
    if (s.type === 'section') return renderSectionSlide(s, i);
    if (s.type === 'ai' || s.type === 'tech') return renderAiSlide(s, i);
    if (s.type === 'build')   return renderBuildSlide(s, i);
    if (s.type === 'podcast') return renderPodcastSlide(s, i);
    if (s.type === 'news')    return renderNewsSlide(s, i, s.section === 'pt_news' ? '#006400' : '#1D4ED8');
    return '';
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Daily Digest — ${esc(today)}</title>
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

  --red:    #DC2626; --red-bg:    #FEF2F2; --red-border:    #FECACA;
  --yellow: #D97706; --yellow-bg: #FFFBEB; --yellow-border: #FDE68A;
  --green:  #16A34A; --green-bg:  #F0FDF4; --green-border:  #BBF7D0;
  --blue:   #2563EB; --blue-bg:   #EFF6FF; --blue-border:   #BFDBFE;

  --x-color:   #D97706;
  --pod-color: #7C3AED;
  --pt-color:  #006400;
  --world-color: #1D4ED8;

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

#deck { position: relative; width: 100vw; height: 100vh; }

.slide {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  opacity: 0; pointer-events: none;
  transform: translateX(28px);
  transition: opacity 0.38s cubic-bezier(0.4,0,0.2,1), transform 0.38s cubic-bezier(0.4,0,0.2,1);
  overflow-y: auto;
}
.slide.active  { opacity: 1; pointer-events: all; transform: translateX(0); }
.slide.leaving { opacity: 0; transform: translateX(-28px); transition-duration: 0.22s; }

/* ── Intro slide ── */
.intro-card {
  width: 100%; max-width: 720px;
  background: var(--surface);
  border-radius: 20px;
  box-shadow: var(--shadow-lg);
  padding: 40px 40px 32px;
  border: 1px solid var(--border);
  position: relative;
  max-height: 92vh;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px;
}
.intro-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #006400, #1D4ED8, #7C3AED, #D97706);
}
.intro-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
.title-badge {
  font-family: 'DM Mono', monospace;
  font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--muted); background: var(--subtle); border: 1px solid var(--border);
  padding: 4px 11px; border-radius: 100px; display: inline-block;
}
.intro-greeting { font-size: 15px; font-weight: 500; color: var(--muted); margin-bottom: 8px; }
.intro-headline {
  font-family: 'Lora', serif;
  font-size: clamp(30px, 6vw, 44px);
  font-weight: 400; line-height: 1.05; letter-spacing: -0.02em;
  color: var(--text); margin-bottom: 10px;
}
.intro-headline em { font-style: italic; color: var(--x-color); }
.intro-date {
  font-family: 'DM Mono', monospace;
  font-size: 11px; color: var(--muted); letter-spacing: 0.04em;
  margin-bottom: 8px;
}

.health-banner { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--muted); }
.health-banner summary { cursor: pointer; }
.health-rows { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; max-width: 220px; }
.health-item { background: var(--subtle); border: 1px solid var(--border); border-radius: 100px; padding: 2px 8px; white-space: nowrap; }
.health-item.health-bad { background: var(--red-bg); border-color: var(--red-border); color: var(--red); }

.since-yesterday {
  margin: 8px 0 16px; padding: 12px 14px;
  background: var(--blue-bg); border: 1px solid var(--blue-border); border-radius: 12px;
}
.since-label { font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--blue); }
.since-yesterday p { font-size: 13px; color: var(--text-2); margin-top: 4px; }

.signal-legend {
  display: flex; flex-wrap: wrap; gap: 12px;
  padding: 10px 12px; margin-bottom: 18px;
  background: var(--subtle); border: 1px solid var(--border-soft); border-radius: 10px;
}
.legend-item {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: 'DM Mono', monospace; font-size: 10px; color: var(--muted);
}
.legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.legend-dot.signal-red    { background: var(--red); }
.legend-dot.signal-yellow { background: var(--yellow); }
.legend-dot.signal-green  { background: var(--green); }
.legend-dot.signal-blue   { background: var(--blue); }

.intro-list { display: flex; flex-direction: column; gap: 32px; margin-bottom: 24px; }
.intro-group { display: flex; flex-direction: column; gap: 12px; }
.intro-group-label {
  font-family: 'DM Mono', monospace; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); margin-bottom: 2px;
}
.intro-item {
  background: var(--surface); border-radius: 16px;
  border: 1px solid var(--border-soft);
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
}
.intro-item:hover { background: var(--subtle); border-color: var(--border); transform: translateY(-1px); }

.intro-item-body {
  display: flex; align-items: center; gap: 18px;
  width: 100%; text-align: left; background: none; cursor: pointer;
  padding: 18px; border: none;
  font-family: inherit; color: var(--text);
}

.intro-thumb-wrap { position: relative; flex-shrink: 0; }
.intro-thumb {
  width: 88px; height: 88px; border-radius: 12px; object-fit: cover;
  border: 1px solid var(--border); display: block; background: var(--subtle);
}
.intro-thumb-round { border-radius: 50%; }
.intro-thumb-fallback {
  width: 88px; height: 88px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--subtle); border: 1px solid var(--border); font-size: 34px;
}
.intro-signal-dot {
  position: absolute; top: -4px; right: -4px;
  width: 16px; height: 16px; border-radius: 50%;
  border: 3px solid var(--surface);
}

.intro-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.intro-item-title { font-size: 17px; font-weight: 600; line-height: 1.4; }
.intro-item-summary { font-size: 14px; line-height: 1.6; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.intro-item-arrow { font-size: 18px; color: var(--muted); opacity: 0; transition: opacity 0.15s; flex-shrink: 0; }
.intro-item:hover .intro-item-arrow { opacity: 1; }

.intro-item-source {
  align-self: flex-start; font-family: 'DM Mono', monospace; font-size: 11px;
  color: var(--x-color); text-decoration: none; margin-top: 2px;
  padding: 2px 0;
}
.intro-item-source:hover { text-decoration: underline; }
.intro-item-source-plain { color: var(--muted); cursor: default; }

.intro-start {
  font-family: 'DM Mono', monospace; font-size: 11px; letter-spacing: 0.08em;
  color: var(--surface); background: var(--text);
  border: none; border-radius: 100px; padding: 12px 20px;
  cursor: pointer; align-self: flex-start;
}
.intro-start:hover { opacity: 0.85; }

/* ── Section Card ── */
.section-card {
  width: 100%; max-width: 580px;
  background: var(--sec-bg, #FFFBEB);
  border: 1px solid var(--sec-border, #FDE68A);
  border-radius: 20px;
  box-shadow: var(--shadow-lg);
  padding: 56px 52px;
  position: relative; overflow: hidden;
}
.section-card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: var(--sec-color, #D97706);
}
.section-card__inner { display: flex; flex-direction: column; gap: 12px; }
.section-emoji { font-size: 40px; }
.section-chapter {
  font-family: 'DM Mono', monospace;
  font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
  color: var(--sec-color, #D97706); opacity: 0.7;
}
.section-title {
  font-family: 'Lora', serif;
  font-size: clamp(32px, 4.5vw, 52px);
  font-weight: 400; line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--sec-color, #D97706);
}
.section-rule {
  width: 48px; height: 3px;
  background: var(--sec-color, #D97706);
  border-radius: 2px;
  margin-top: 8px;
  opacity: 0.4;
}

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

.card-left {
  background: var(--subtle);
  border-right: 1px solid var(--border);
  padding: 28px 26px;
  display: flex; flex-direction: column; gap: 16px;
  position: relative; overflow: hidden;
}

.news-left { background: #EFF6FF; border-right-color: #BFDBFE; }
.news-source-tag {
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--sec-color, #1D4ED8);
  opacity: 0.8;
}
.news-headline {
  font-family: 'Lora', serif;
  font-size: clamp(15px, 1.7vw, 19px);
  font-weight: 600; line-height: 1.3;
  color: var(--text);
  padding-right: 8px;
}
.news-hook { border-left-color: var(--sec-color, #1D4ED8) !important; }

.card-media {
  position: relative; width: 100%; aspect-ratio: 16 / 9;
  border-radius: 12px; overflow: hidden; margin-bottom: 4px;
  background: linear-gradient(135deg, #EFF6FF, #BFDBFE);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  flex: 0 0 auto;
}
.card-media-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border: 0; display: block; }

/* Secondary thumbnail shown alongside an autoplaying Short, when a story
   also has a real article image — keeps the extra picture instead of
   throwing it away. */
.card-media-secondary {
  width: 100%; max-width: 220px; aspect-ratio: 16 / 9;
  border-radius: 10px; overflow: hidden; margin: 8px auto 0;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.08);
}
.card-media-secondary-img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* Shorts video (9:16, portrait) — sized to sit comfortably in the left column */
.card-video {
  position: relative; width: 100%; max-width: 220px;
  aspect-ratio: 9 / 16; border-radius: 12px; overflow: hidden;
  margin: 0 auto 4px; background: #000;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  flex: 0 0 auto;
}
.card-video-frame { position: absolute; inset: 0; width: 100%; height: 100%; }
.card-video-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.card-video-open {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  width: 24px; height: 24px; border-radius: 50%;
  background: rgba(0,0,0,0.55); color: white;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; text-decoration: none;
}
.card-video-open:hover { background: rgba(0,0,0,0.8); }

.hook-text {
  font-size: clamp(13px, 1.4vw, 15px);
  line-height: 1.6; color: var(--text-2);
  font-weight: 500;
  padding: 12px 14px;
  background: var(--surface);
  border-radius: 10px;
  border-left: 3px solid var(--x-color);
  flex: 0 0 auto;
}
.podcast-left .hook-text { border-left-color: var(--pod-color); }

.card-index {
  position: absolute; bottom: -10px; right: 10px;
  font-family: 'Lora', serif; font-size: 80px; font-weight: 600;
  color: rgba(0,0,0,0.05); line-height: 1;
  user-select: none; pointer-events: none;
}

.author-block { display: flex; align-items: center; gap: 10px; }
.author-avatar {
  width: 40px; height: 40px; border-radius: 50%;
  object-fit: cover; border: 2px solid var(--border); flex-shrink: 0;
}
.build-icon {
  width: 40px; height: 40px; border-radius: 10px; background: var(--green-bg);
  display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0;
  border: 1px solid var(--green-border);
}
.author-name {
  font-family: 'Lora', serif;
  font-size: clamp(16px, 1.8vw, 20px);
  font-weight: 600; color: var(--text); line-height: 1.1;
}
.author-role { font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4; }

.signal-badge {
  font-family: 'DM Mono', monospace; font-size: 10px; padding: 4px 10px; border-radius: 100px;
  align-self: flex-start;
}
.signal-red    { background: var(--red-bg);    color: var(--red); }
.signal-yellow { background: var(--yellow-bg); color: var(--yellow); }
.signal-green  { background: var(--green-bg);  color: var(--green); }
.signal-blue   { background: var(--blue-bg);   color: var(--blue); }

.card-right {
  padding: 24px 28px;
  display: flex; flex-direction: column; gap: 16px;
  overflow-y: auto;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}

.right-section { display: flex; flex-direction: column; gap: 10px; }
.section-label {
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--muted);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-soft);
}

.insight-list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.insight-item {
  display: flex; align-items: baseline; gap: 9px;
  font-size: clamp(13px, 1.4vw, 15px);
  line-height: 1.65; color: var(--text);
}
.insight-dot { color: var(--x-color); font-size: 7px; flex-shrink: 0; margin-top: 5px; }
.insight-item strong { background: #FEF9C3; padding: 0 2px; border-radius: 2px; font-weight: 600; color: var(--text); }

.for-you-box {
  background: linear-gradient(135deg, #EFF6FF 0%, #F0FDF4 100%);
  border: 1px solid #BFDBFE;
  border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 6px;
}
.for-you-label {
  font-family: 'DM Mono', monospace;
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--blue); font-weight: 400;
}
.for-you-text { font-size: clamp(13px, 1.4vw, 14px); line-height: 1.7; color: var(--text-2); }
.for-you-text strong { color: var(--text); font-weight: 600; }

.why-cut { font-size: 11px; color: var(--muted); font-style: italic; }

.url-row { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; border-top: 1px solid var(--border-soft); }
.source-url {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: 'DM Mono', monospace;
  font-size: 10px; color: var(--muted); text-decoration: none;
  padding: 3px 8px; border-radius: 6px;
  background: var(--subtle); border: 1px solid var(--border);
}
.source-url:hover { color: var(--blue); border-color: #BFDBFE; }

.podcast-show {
  font-family: 'DM Mono', monospace;
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--pod-color);
}
.podcast-episode { font-family: 'Lora', serif; font-size: clamp(14px, 1.6vw, 18px); font-weight: 400; line-height: 1.35; color: var(--text); }
.takeaway-box {
  background: var(--surface);
  border-left: 3px solid var(--pod-color);
  border-radius: 0 8px 8px 0;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 4px;
}
.takeaway-label { font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--pod-color); }
.takeaway-text { font-size: clamp(12px, 1.3vw, 14px); line-height: 1.6; color: var(--text); font-weight: 500; }
.yt-thumb-link { display: block; border-radius: 8px; overflow: hidden; position: relative; flex-shrink: 0; border: 1px solid var(--border); text-decoration: none; }
.yt-thumb { width: 100%; height: 80px; object-fit: cover; display: block; }
.yt-play {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(0,0,0,0.65);
  display: flex; align-items: center; justify-content: center;
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
  transition: background 0.18s, color 0.18s;
}
.nav-btn:hover { background: var(--text); color: white; border-color: var(--text); }
.nav-btn svg { width: 12px; height: 12px; }
#counter { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--muted); min-width: 44px; text-align: center; }
.nav-home {
  width: 28px; height: 28px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--subtle);
  color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px;
}
.nav-home:hover { background: var(--text); color: white; border-color: var(--text); }

#progress { position: fixed; top: 0; left: 0; height: 3px; background: linear-gradient(90deg, #006400, #1D4ED8, #7C3AED, #D97706); transition: width 0.38s cubic-bezier(0.4,0,0.2,1); z-index: 200; }

@media (max-width: 680px) {
  .content-card { grid-template-columns: 1fr; grid-template-rows: auto 1fr; height: auto; max-height: 90vh; }
  .card-left { border-right: none; border-bottom: 1px solid var(--border); }
  .card-right { max-height: 55vh; }
  .intro-card { padding: 28px 22px; }
}
</style>
</head>
<body>

<div id="progress"></div>
<div id="deck">
${slidesHTML}
</div>
<div id="nav">
  <button class="nav-home" id="home" aria-label="Back to overview" title="Back to overview">⌂</button>
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

// Swap a card-video's iframe in/out so only the active slide's Short ever
// plays — mute is required for autoplay to fire in mobile browsers.
function setSlideVideoPlaying(slideEl, playing) {
  const box = slideEl?.querySelector('.card-video');
  if (!box) return;
  const frame = box.querySelector('.card-video-frame');
  const id = box.dataset.ytId;
  if (!id) return;
  if (playing) {
    frame.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + id +
      '?autoplay=1&mute=1&playsinline=1&loop=1&playlist=' + id +
      '&controls=1&rel=0&modestbranding=1" allow="autoplay; encrypted-media" loading="lazy"></iframe>';
  } else {
    frame.innerHTML = '';
  }
}

function goTo(n) {
  if (n === current || n < 0 || n >= TOTAL) return;
  const els = allSlides();
  els[current].classList.remove('active');
  els[current].classList.add('leaving');
  setSlideVideoPlaying(els[current], false);
  const prev = current;
  current = n;
  requestAnimationFrame(() => {
    els[current].classList.add('active');
    setSlideVideoPlaying(els[current], true);
  });
  setTimeout(() => els[prev].classList.remove('leaving'), 380);
  document.getElementById('counter').textContent = current === 0 ? 'Overview' : (current) + ' / ' + (TOTAL - 1);
  document.getElementById('progress').style.width = ((current + 1) / TOTAL * 100) + '%';
}

document.getElementById('next').addEventListener('click', () => goTo(current + 1));
document.getElementById('prev').addEventListener('click', () => goTo(current - 1));
document.getElementById('home').addEventListener('click', () => goTo(0));

document.querySelectorAll('[data-goto]').forEach(el => {
  el.addEventListener('click', () => goTo(parseInt(el.dataset.goto, 10)));
});

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goTo(current + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(current - 1); }
  if (e.key === 'Escape') { goTo(0); }
});
let tx = 0;
document.addEventListener('touchstart', e => { tx = e.touches[0].clientX; });
document.addEventListener('touchend', e => {
  const d = tx - e.changedTouches[0].clientX;
  if (Math.abs(d) > 50) d > 0 ? goTo(current + 1) : goTo(current - 1);
});
document.getElementById('counter').textContent = 'Overview';
document.getElementById('progress').style.width = (1 / TOTAL * 100) + '%';
<\/script>
</body>
</html>`;
}
