#!/usr/bin/env node
/**
 * remix-digest.js
 * Reads my-feed.json from stdin.
 * Calls Claude API to produce a 4-section structured digest:
 *   pt_news, world_news, tech, ai (+ podcasts)
 * Writes output to digest-draft.json (repo root) AND stdout.
 *
 * Required env: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Load .env
const envPath = path.join(os.homedir(), '.follow-builders', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write('remix-digest: ANTHROPIC_API_KEY is not set\n');
  process.exit(1);
}
process.stderr.write(`remix-digest: API key present (${apiKey.slice(0, 10)}...)\n`);

const client = new Anthropic({ apiKey });

// digest-draft.json lives at repo root (one level up from scripts/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAFT_PATH = path.join(__dirname, '..', 'digest-draft.json');

// ── News enrichment (images + YouTube Shorts) ────────────────────
const ENRICH_TIMEOUT_MS = 10_000;

async function fetchOgImage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ai-digest/1.0)' },
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
            || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    return og ? og[1] : null;
  } catch { return null; }
}

async function googleImageSearch(query, apiKey, cx) {
  if (!apiKey || !cx) return null;
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&searchType=image&num=3&safe=active&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const first = (data.items || []).find(i => i.link && /^https?:/.test(i.link));
    return first ? first.link : null;
  } catch { return null; }
}

async function youtubeShortsSearch(query, apiKey) {
  if (!apiKey) return null;
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&maxResults=5&safeSearch=strict&q=${encodeURIComponent(query + ' shorts')}&key=${apiKey}`;
  try {
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS) });
    if (!sr.ok) return null;
    const sData = await sr.json();
    const ids = (sData.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (ids.length === 0) return null;

    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids.join(',')}&key=${apiKey}`;
    const dr = await fetch(detailsUrl, { signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS) });
    if (!dr.ok) return null;
    const dData = await dr.json();
    const parseISO = d => {
      const m = (d || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
      return (+(m?.[1] || 0)) * 60 + (+(m?.[2] || 0));
    };
    const short = (dData.items || []).find(v => parseISO(v.contentDetails?.duration) <= 60);
    if (!short) return null;
    return {
      id: short.id,
      title: short.snippet?.title || '',
      thumbnail: short.snippet?.thumbnails?.medium?.url || `https://img.youtube.com/vi/${short.id}/hqdefault.jpg`,
    };
  } catch { return null; }
}

async function enrichNewsItem(item) {
  const query = item.headline || item.hook || '';
  if (!query) return item;

  let image = item.url ? await fetchOgImage(item.url) : null;
  if (!image) image = await googleImageSearch(query, process.env.GOOGLE_SEARCH_API_KEY, process.env.GOOGLE_SEARCH_CX);
  if (image) item.image = image;

  const video = await youtubeShortsSearch(query, process.env.YOUTUBE_API_KEY);
  if (video) item.video = video;

  return item;
}

let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { process.stderr.write('remix-digest: invalid JSON\n'); process.exit(1); }

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  // ── Separate X accounts by category ────────────────────────────
  const xAll = (data.x || []).filter(b =>
    (b.tweets || []).some(t => t.text?.trim().length > 15)
  );
  const xAI   = xAll.filter(b => b.category === 'ai'   || !b.category); // default to ai
  const xTech = xAll.filter(b => b.category === 'tech');
  const podcasts = data.podcasts || [];
  const rssByCategory = {};
  for (const feed of (data.rss || [])) {
    if (!rssByCategory[feed.category]) rssByCategory[feed.category] = [];
    rssByCategory[feed.category].push(feed);
  }

  // ── Build source sections ────────────────────────────────────────
  const sections = [];

  // PT News section
  const ptFeeds = rssByCategory['pt_news'] || [];
  if (ptFeeds.length > 0) {
    const lines = ptFeeds.flatMap(f =>
      (f.items || []).map(i => `  • [${f.feed_name}] ${i.title}${i.contentSnippet ? ' — ' + i.contentSnippet : ''}\n    URL: ${i.link}`)
    ).join('\n');
    sections.push(`=== PT_NEWS ===\n${lines}`);
  }

  // World News section
  const worldFeeds = rssByCategory['world_news'] || [];
  if (worldFeeds.length > 0) {
    const lines = worldFeeds.flatMap(f =>
      (f.items || []).map(i => `  • [${f.feed_name}] ${i.title}${i.contentSnippet ? ' — ' + i.contentSnippet : ''}\n    URL: ${i.link}`)
    ).join('\n');
    sections.push(`=== WORLD_NEWS ===\n${lines}`);
  }

  // Tech section (X accounts + RSS)
  const techRssFeeds = rssByCategory['tech'] || [];
  const techLines = [];
  xTech.forEach((b, i) => {
    const bio = (b.bio || '').replace(/\s+/g, ' ').trim();
    const tweets = (b.tweets || [])
      .filter(t => t.text?.trim().length > 15)
      .slice(0, 4)
      .map(t => `  • TEXT: ${t.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()}\n    URL: ${t.url || ''}`)
      .join('\n');
    techLines.push(`--- X Builder: ${b.name || b.handle} ---\nBio: ${bio}\nTweets:\n${tweets}`);
  });
  techRssFeeds.forEach(f => {
    const items = (f.items || []).map(i => `  • [${f.feed_name}] ${i.title}\n    URL: ${i.link}`).join('\n');
    techLines.push(`--- RSS: ${f.feed_name} ---\n${items}`);
  });
  if (techLines.length > 0) {
    sections.push(`=== TECH ===\n${techLines.join('\n\n')}`);
  }

  // AI section (X accounts + podcasts)
  const aiLines = [];
  xAI.forEach((b, i) => {
    const bio = (b.bio || '').replace(/\s+/g, ' ').trim();
    const tweets = (b.tweets || [])
      .filter(t => t.text?.trim().length > 15)
      .slice(0, 4)
      .map(t => `  • TEXT: ${t.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()}\n    URL: ${t.url || ''}`)
      .join('\n');
    aiLines.push(`--- X Builder: ${b.name || b.handle} ---\nBio: ${bio}\nTweets:\n${tweets}`);
  });
  podcasts.forEach((p, i) => {
    aiLines.push(`--- Podcast: ${p.name} ---\nTitle: ${p.title}\nURL: ${p.url}\nTranscript:\n${(p.transcript || '').slice(0, 5000)}`);
  });
  if (aiLines.length > 0) {
    sections.push(`=== AI ===\n${aiLines.join('\n\n')}`);
  }

  // ── System prompt ─────────────────────────────────────────────────
  const systemPrompt = `You are the executive assistant and chief curator for Pedro, a Portuguese PM building AI products.

Pedro's profile:
- Building and selling AI products/services in Portugal
- Product Manager with UX and strategy background
- Learning to be technically fluent in AI — curious, not expert
- Goal: use AI to build products faster, find new business models, stay ahead

Your job: Transform raw content into a SCANNABLE EXECUTIVE BRIEF across 4 sections.
Pedro has 90 seconds per slide. Every word must earn its place.

OUTPUT FORMAT — respond ONLY with valid JSON, no markdown fences:

{
  "pt_news": [
    {
      "headline": "Short punchy headline, max 12 words",
      "hook": "One sentence. What happened and why it matters.",
      "key_points": [
        "First concrete detail or implication",
        "Second concrete detail (optional)"
      ],
      "for_you": "1-2 sentences. What does this mean for Pedro building in Portugal? Be specific.",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "url": "article url",
      "source_name": "Publication name"
    }
  ],
  "world_news": [
    {
      "headline": "Short punchy headline, max 12 words",
      "hook": "One sentence. What happened and why it matters.",
      "key_points": [
        "First concrete detail or implication",
        "Second concrete detail (optional)"
      ],
      "for_you": "1-2 sentences. Global context for a Portuguese entrepreneur.",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "url": "article url",
      "source_name": "Publication name"
    }
  ],
  "tech": [
    {
      "name": "Person or source name",
      "role": "Title · Company (for X accounts) or RSS source name",
      "hook": "One punchy sentence. Max 15 words.",
      "insights": [
        "First key insight — specific, concrete",
        "Second key insight (optional)"
      ],
      "for_you": "2-3 sentences. What does this mean for someone building tech products?",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "urls": ["url1"],
      "handle": "x handle if applicable, else empty string",
      "index": 1
    }
  ],
  "ai": [
    {
      "name": "Person or show name",
      "role": "Title · Company or 'Podcast'",
      "hook": "One punchy sentence. Max 15 words.",
      "insights": [
        "First key insight — specific, concrete",
        "Second key insight",
        "Third key insight (optional)"
      ],
      "for_you": "2-3 sentences. What does this mean for Pedro building AI products?",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "urls": ["url1"],
      "handle": "x handle if applicable, else empty string",
      "index": 1
    }
  ],
  "podcasts": [
    {
      "show": "Show Name",
      "episode": "Episode Title",
      "takeaway": "Single sentence. The ONE thing Pedro needs to know.",
      "key_points": [
        "Point 1 — concrete finding or argument",
        "Point 2 — supporting evidence or example",
        "Point 3 — implication for builders"
      ],
      "for_you": "2-3 sentences. What does this mean for Pedro specifically?",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "url": "episode url"
    }
  ]
}

RULES:
- Include only sections that have actual content. Omit empty arrays entirely.
- pt_news and world_news: pick the 3-5 most relevant stories. Skip duplicates.
- tech and ai: each X builder = one entry; each podcast also gets an entry in ai.
- hook: punchy, present tense, no jargon. "X does Y" not "X announced that Y"
- insights: start each with a strong verb or concrete noun. No "he said that". Just the fact.
- Bold key phrases with **double asterisks** — max 2 per bullet.
- for_you: most important field. Be a trusted advisor. Frame everything in terms of building and selling AI products in Portugal.
- signal: 🟢 apply right now, 🔴 threat or disruption, 🟡 trend to monitor, 💡 concept to learn.
- Never pad. Never summarize what you just said. No "In conclusion".`;

  const userPrompt = `Today: ${today}

Produce the JSON digest for these sources:

${sections.join('\n\n')}`;

  process.stderr.write(`remix-digest: sections built (${sections.length}), calling Claude...\n`);

  let remixed;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: '{' }
      ],
    });

    // Prepend '{' (prefill) and strip any trailing prose after the last '}'
    const responseText = '{' + msg.content[0].text;
    const end = responseText.lastIndexOf('}');
    process.stderr.write(`remix-digest: response length=${responseText.length}, JSON end=${end}\n`);
    remixed = JSON.parse(responseText.slice(0, end + 1));
  } catch (e) {
    process.stderr.write(`remix-digest: error — ${e.message}\n${e.stack || ''}\n`);
    process.exit(1);
  }

  // Enrich news items with images + YouTube Shorts (parallel, best-effort)
  const allNews = [...(remixed.pt_news || []), ...(remixed.world_news || [])];
  if (allNews.length > 0) {
    process.stderr.write(`remix-digest: enriching ${allNews.length} news items with media...\n`);
    await Promise.all(allNews.map(enrichNewsItem));
    const withImage = allNews.filter(i => i.image).length;
    const withVideo = allNews.filter(i => i.video).length;
    process.stderr.write(`remix-digest: enriched ${withImage}/${allNews.length} with image, ${withVideo}/${allNews.length} with video\n`);
  }

  // ── Build final output ────────────────────────────────────────────
  // Enrich tech and ai entries with handle/index from original data
  let globalIndex = 1;

  const enrichXEntries = (entries, sourceList) =>
    (entries || []).map((b, i) => {
      const orig = sourceList[i] || {};
      const firstUrl = (orig.tweets || [])[0]?.url || '';
      const handle = b.handle || (firstUrl.match(/x\.com\/([^/]+)\/status/) || [])[1] || '';
      return {
        name:     b.name,
        role:     b.role,
        hook:     b.hook,
        insights: b.insights || [],
        for_you:  b.for_you,
        signal:   b.signal || '🟡',
        urls:     (b.urls || []).filter(Boolean),
        handle,
        index:    globalIndex++,
      };
    });

  const techEntries = enrichXEntries(remixed.tech, xTech);
  const aiEntries   = enrichXEntries(remixed.ai, xAI);

  const podcastEntries = (remixed.podcasts || []).map((p, i) => {
    const orig = podcasts[i] || {};
    const videoId = (orig.url || '').match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1] || '';
    return {
      show:       p.show || orig.name,
      episode:    p.episode || orig.title,
      takeaway:   p.takeaway,
      key_points: p.key_points || [],
      for_you:    p.for_you,
      signal:     p.signal || '🟡',
      url:        p.url || orig.url,
      videoId,
      index:      globalIndex++,
    };
  });

  const output = {
    date: today,
    pt_news:    remixed.pt_news    || [],
    world_news: remixed.world_news || [],
    tech:       techEntries,
    ai:         aiEntries,
    podcasts:   podcastEntries,
  };

  // Write draft file to repo root for manual review
  fs.writeFileSync(DRAFT_PATH, JSON.stringify(output, null, 2));
  process.stderr.write(`remix-digest: draft written to ${DRAFT_PATH}\n`);

  process.stdout.write(JSON.stringify(output) + '\n');
});
