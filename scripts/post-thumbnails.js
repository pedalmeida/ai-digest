#!/usr/bin/env node
/**
 * post-thumbnails.js <thread_ts>
 * Replies in the #feed card's thread with one thumbnail card per top story
 * (Pedro, 2026-11-17): image, plain headline, one line, click to open.
 * Picks up to 5: top ai items first, then x_top. Image = og:image of the article,
 * or the media of the X post via fxtwitter. No image found = text-only card.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const DRAFT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'digest-draft.json');
const threadTs = process.argv[2];
if (!threadTs || !fs.existsSync(DRAFT)) process.exit(0);
const data = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
const clean = s => String(s || '').replace(/\*\*/g, '').replace(/\s*[—–]\s*/g, ', ').trim();

async function get(url, json) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-digest)' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(String(r.status));
  return json ? r.json() : r.text();
}

async function imageFor(url) {
  try {
    const m = url.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
    if (m) {
      const j = await get(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, true);
      const t = j.tweet || {};
      const media = t.media || {};
      return (media.photos && media.photos[0] && media.photos[0].url) || (media.videos && media.videos[0] && media.videos[0].thumbnail_url)
        || (t.card && t.card.image) || null;
    }
    const html = await get(url);
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!og) return null;
    const img = new URL(og[1].replace(/&amp;/g, '&'), url).href;
    return img.startsWith('https://') ? img : null;
  } catch { return null; }
}

const picks = [];
const seen = new Set();
const add = (url, title, line) => { if (url && !seen.has(url) && title) { seen.add(url); picks.push({ url, title: clean(title), line: clean(line) }); } };
for (const a of (data.ai || []).slice(0, 3)) add((a.urls || [])[0], a.hook, a.for_you);
for (const t of (data.x_top || [])) add(t.url, t.title || t.why, t.title ? t.why : '');
const top = picks.slice(0, 5);

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel: process.env.SLACK_CHANNEL_ID, thread_ts: threadTs, unfurl_links: false, unfurl_media: false, ...payload });
    const req = https.request('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_OPS_BOT_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { const r = JSON.parse(d); r.ok ? resolve(r) : reject(new Error(d)); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

for (const p of top) {
  const img = await imageFor(p.url);
  const text = `*<${p.url}|${p.title}>*${p.line ? `\n${p.line}` : ''}`;
  const section = { type: 'section', text: { type: 'mrkdwn', text } };
  if (img) section.accessory = { type: 'image', image_url: img, alt_text: p.title };
  try { await post({ text: p.title, blocks: [section] }); }
  catch (e) { // bad image URL: retry without it
    if (img) { delete section.accessory; await post({ text: p.title, blocks: [section] }).catch(() => {}); }
  }
}
