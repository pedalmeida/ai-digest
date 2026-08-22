#!/usr/bin/env node
/**
 * remix-digest.js
 * Reads my-feed.json from stdin.
 * Calls Claude (Sonnet 5) to produce the structured digest:
 *   ai (deep-dive), build_this, podcasts, then a thin pt_news/world_news/tech strip.
 * Dedupes against state/seen.json (rolling 7-day memory) before synthesis,
 * and updates it after.
 * Writes output to digest-draft.json (repo root) AND stdout.
 *
 * Required env: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadState, saveState, buildSeenContext, normalizeUrl } from './digest-state.js';

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

const client = new Anthropic({ apiKey });
const MODEL = 'claude-sonnet-5';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DRAFT_PATH = path.join(REPO_ROOT, 'digest-draft.json');

// ── News enrichment (images) ──────────────────────────────────────
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

async function enrichNewsItem(item) {
  const query = item.headline || item.hook || '';
  if (!query) return item;
  const primaryUrl = item.url || (item.urls || [])[0] || '';
  let image = primaryUrl ? await fetchOgImage(primaryUrl) : null;
  if (!image) image = await googleImageSearch(query, process.env.GOOGLE_SEARCH_API_KEY, process.env.GOOGLE_SEARCH_CX);
  if (image) item.image = image;
  return item;
}

// ── YouTube Shorts enrichment ────────────────────────────────────────
// Finds a Short (<=60s) matching a story's topic for autoplay in the card.
// Best-effort only: a missing key, a quota error, or no match all resolve
// to "no video" — never fails the run. build_this/GitHub items are skipped
// entirely (a repo doesn't have a "story" to illustrate).
function parseISODuration(d) {
  const m = (d || '').match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  return (+(m?.[1] || 0)) * 60 + (+(m?.[2] || 0));
}

// Common words carry no topical signal — stripped before keyword-overlap scoring.
const STOPWORDS = new Set(['the','a','an','and','or','but','not','just','with','for','from','into','onto','this','that','these','those','is','are','was','were','be','been','of','to','in','on','at','as','it','its','their','his','her','new','real']);

function keywordsOf(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9À-ÿ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

// Require the candidate's title to share real topical overlap with the
// query — otherwise a Short about something else entirely (matched only on
// a generic keyword like "AI") slips through as a false "match found".
function isRelevantMatch(query, candidateTitle) {
  const queryWords = keywordsOf(query);
  const titleWords = keywordsOf(candidateTitle);
  if (queryWords.size === 0) return false;
  let overlap = 0;
  for (const w of queryWords) if (titleWords.has(w)) overlap += 1;
  return overlap >= Math.min(2, queryWords.size);
}

async function youtubeShortsSearch(query, apiKey) {
  if (!apiKey || !query) return null;
  try {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short&maxResults=8&safeSearch=strict&relevanceLanguage=en&q=${encodeURIComponent(query)}&key=${apiKey}`;
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS) });
    if (!sr.ok) return null;
    const sData = await sr.json();
    const candidates = (sData.items || []).filter(i => i.id?.videoId);
    if (candidates.length === 0) return null;

    const ids = candidates.map(i => i.id.videoId);
    const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet,status&id=${ids.join(',')}&key=${apiKey}`;
    const dr = await fetch(detailsUrl, { signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS) });
    if (!dr.ok) return null;
    const dData = await dr.json();

    const short = (dData.items || []).find(v =>
      parseISODuration(v.contentDetails?.duration) > 0 &&
      parseISODuration(v.contentDetails?.duration) <= 60 &&
      v.status?.embeddable !== false &&
      isRelevantMatch(query, v.snippet?.title)
    );
    if (!short) return null;

    return { id: short.id, title: short.snippet?.title || '' };
  } catch {
    return null;
  }
}

// Each item type gets its own query heuristic — the query is what makes
// this useful instead of noise, so it's tailored per section rather than
// reusing one field blindly.
function videoQueryFor(item, kind) {
  if (kind === 'ai' || kind === 'tech') return item.hook || item.name || '';
  if (kind === 'news') return item.headline || item.hook || '';
  return ''; // build_this and podcasts don't use search (see enrichVideos)
}

async function enrichVideos(output, apiKey) {
  if (!apiKey) {
    process.stderr.write('remix-digest: YOUTUBE_API_KEY not set — skipping video enrichment\n');
    return { attempted: 0, found: 0 };
  }

  const targets = [
    ...(output.ai || []).map(item => ({ item, kind: 'ai' })),
    ...(output.tech || []).map(item => ({ item, kind: 'tech' })),
    ...(output.pt_news || []).map(item => ({ item, kind: 'news' })),
    ...(output.world_news || []).map(item => ({ item, kind: 'news' })),
  ];

  let found = 0;
  await Promise.all(targets.map(async ({ item, kind }) => {
    const query = videoQueryFor(item, kind);
    const video = await youtubeShortsSearch(query, apiKey);
    if (video) { item.video = video; found += 1; }
  }));

  // Podcasts already point at a real YouTube video — no search needed, just embed it.
  for (const p of output.podcasts || []) {
    const videoId = (p.url || '').match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1];
    if (videoId) { p.video = { id: videoId, title: p.episode || '' }; found += 1; }
  }

  return { attempted: targets.length + (output.podcasts || []).length, found };
}

// Walk the response character by character to find the outermost balanced {} object.
// Handles cases where Claude emits trailing prose or a '}' appears inside a string value.
function extractJSON(text) {
  let depth = 0, inString = false, escape = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}') { if (--depth === 0 && start !== -1) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new SyntaxError('No complete JSON object found in Claude response');
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

  const state = await loadState(REPO_ROOT);
  const { seenUrls, seenHeadlines } = buildSeenContext(state);

  // ── Separate X accounts by category ────────────────────────────
  const xAll = (data.x || []).filter(b =>
    (b.tweets || []).some(t => t.text?.trim().length > 15)
  );
  const xAI   = xAll.filter(b => b.category === 'ai'   || !b.category);
  const xTech = xAll.filter(b => b.category === 'tech');
  const podcasts = data.podcasts || [];
  const hackernews = data.hackernews || [];
  const githubTrending = data.githubTrending || [];
  const rssByCategory = {};
  for (const feed of (data.rss || [])) {
    if (!rssByCategory[feed.category]) rssByCategory[feed.category] = [];
    rssByCategory[feed.category].push(feed);
  }

  // Rank tweets by engagement (likes+RTs+bookmarks) instead of chronological slice.
  function topTweets(tweets, n) {
    return [...(tweets || [])]
      .filter(t => t.text?.trim().length > 15)
      .sort((a, b) => {
        const scoreA = (a.likes || 0) + (a.retweets || 0) * 2 + (a.metrics?.bookmark_count || 0);
        const scoreB = (b.likes || 0) + (b.retweets || 0) * 2 + (b.metrics?.bookmark_count || 0);
        return scoreB - scoreA;
      })
      .slice(0, n);
  }

  function formatBuilder(b) {
    const bio = (b.bio || '').replace(/\s+/g, ' ').trim();
    const tweets = topTweets(b.tweets, 4)
      .map(t => `  • [${t.likes || 0}♥ ${t.retweets || 0}rt] ${t.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()}\n    URL: ${t.url || ''}`)
      .join('\n');
    return `--- X Builder: ${b.name || b.handle} ---\nBio: ${bio}\nTop tweets (ranked by engagement):\n${tweets}`;
  }

  // Sort RSS feeds within a category by weight (AINews/HN-derived feeds first).
  function feedLines(feeds) {
    return [...feeds]
      .sort((a, b) => (b.weight || 1) - (a.weight || 1))
      .flatMap(f =>
        (f.items || []).map(i => `  • [${f.feed_name}] ${i.title}${i.contentSnippet ? ' — ' + i.contentSnippet : ''}\n    URL: ${i.link}`)
      ).join('\n');
  }

  // ── Build source sections ────────────────────────────────────────
  const sections = [];

  // AI section (richest — X builders, podcasts, weighted RSS)
  const aiLines = [];
  xAI.forEach(b => aiLines.push(formatBuilder(b)));
  (rssByCategory['ai'] || [])
    .sort((a, b) => (b.weight || 1) - (a.weight || 1))
    .forEach(f => {
      const items = (f.items || []).map(i => `  • ${i.title}${i.contentSnippet ? ' — ' + i.contentSnippet : ''}\n    URL: ${i.link}`).join('\n');
      aiLines.push(`--- RSS: ${f.feed_name} ---\n${items}`);
    });
  podcasts.forEach(p => {
    aiLines.push(`--- Podcast: ${p.name} ---\nTitle: ${p.title}\nURL: ${p.url}\nDescription:\n${(p.description || p.transcript || '').slice(0, 1500)}`);
  });
  if (aiLines.length > 0) sections.push(`=== AI ===\n${aiLines.join('\n\n')}`);

  // Build-this section (GitHub trending + Hacker News, ranked)
  const buildLines = [];
  if (githubTrending.length > 0) {
    buildLines.push('--- GitHub Trending (today) ---\n' + githubTrending
      .map(r => `  • ${r.repo}: ${r.description}\n    URL: ${r.url}`).join('\n'));
  }
  if (hackernews.length > 0) {
    buildLines.push('--- Hacker News (AI/dev-tools, ranked by points) ---\n' + hackernews
      .map(s => `  • [${s.points}pts, ${s.comments} comments] ${s.title}\n    URL: ${s.link}\n    Discussion: ${s.discussionUrl}`).join('\n'));
  }
  if (buildLines.length > 0) sections.push(`=== BUILD_THIS_CANDIDATES ===\n${buildLines.join('\n\n')}`);

  // Community signal (/last30days sweep: topics ranked by real cross-source
  // engagement). Optional — the key is absent unless fetch-last30days.js ran.
  const l30dLines = [];
  for (const sweep of (data.last30days || [])) {
    const topics = (sweep.topics || []).map(t => {
      const eng = Object.entries(t.engagement || {})
        .map(([src, m]) => `${src}: ${Object.entries(m).map(([k, v]) => `${v} ${k}`).join(', ')}`)
        .join(' | ');
      const comment = t.topComment ? `\n    Top comment: "${t.topComment}"` : '';
      return `  \u2022 [velocity ${Math.round(t.velocityScore || 0)}, ${t.momentum || 'unknown'}, ${t.corroborationCount || 0} corroborating sources] ${t.topic}\n    Why: ${t.whySpiking}\n    Engagement: ${eng || 'n/a'}${comment}\n    Evidence: ${(t.evidenceUrls || []).join(' , ')}`;
    }).join('\n');
    if (topics) l30dLines.push(`--- /last30days sweep: ${sweep.domain} ---\n${topics}`);
  }
  if (l30dLines.length > 0) sections.push(`=== COMMUNITY_SIGNAL ===\n${l30dLines.join('\n\n')}`);

  // Tech strip (thin)
  const techLines = [];
  xTech.forEach(b => techLines.push(formatBuilder(b)));
  (rssByCategory['tech'] || []).forEach(f => {
    const items = (f.items || []).map(i => `  • [${f.feed_name}] ${i.title}\n    URL: ${i.link}`).join('\n');
    techLines.push(`--- RSS: ${f.feed_name} ---\n${items}`);
  });
  if (techLines.length > 0) sections.push(`=== TECH ===\n${techLines.join('\n\n')}`);

  // PT News strip (thin)
  const ptFeeds = rssByCategory['pt_news'] || [];
  if (ptFeeds.length > 0) sections.push(`=== PT_NEWS ===\n${feedLines(ptFeeds)}`);

  // World News strip (thin)
  const worldFeeds = rssByCategory['world_news'] || [];
  if (worldFeeds.length > 0) sections.push(`=== WORLD_NEWS ===\n${feedLines(worldFeeds)}`);

  // What was already shown recently (dedup + momentum context)
  let memoryBlock = '';
  if (seenHeadlines.length > 0) {
    const recent = seenHeadlines.slice(-40).map(h => `  • [${h.date}] ${h.headline}`).join('\n');
    memoryBlock = `\n\nALREADY COVERED IN THE LAST 7 DAYS (do not repeat as new; if a story has developed further, say what changed):\n${recent}`;
  }

  // ── System prompt ─────────────────────────────────────────────────
  const systemPrompt = `You are Pedro's chief of staff for AI and building. You write his daily morning brief.

WHO PEDRO IS (bias every judgment call to this, not a generic founder):
- Portuguese Product Manager, UX + product strategy background, learning to be technically fluent — not yet a developer, but building real products.
- Actively building and selling: an AI agency for Portuguese SMBs (his main bet), a yoga/meditation educational platform, a possible micro-SaaS.
- Reads this at 8am to decide what to pay attention to and what to go BUILD today.
- He wants to feel plugged into AI and ready to build, not caught up on news. AI + hands-on building must dominate. PT/world/tech news is a thin scannable strip, present but secondary.

OUTPUT FORMAT — respond ONLY with valid JSON, no markdown fences:

{
  "ai": [
    {
      "name": "Person, show, or source name",
      "role": "Title · Company, or 'Podcast', or RSS source name",
      "hook": "One punchy sentence on what actually happened. Max 15 words.",
      "insights": [
        "First concrete fact or development — specific, not vibes",
        "Second concrete fact",
        "Third (optional)"
      ],
      "for_you": "1-2 sentences, SPECIFIC to Pedro's AI agency for PT SMBs or his other bets. Must fail the 'swap test': if this sentence could apply to any random founder anywhere, cut it or make it specific. It is OK to write 'No direct action here, filed for awareness' rather than pad.",
      "why_it_made_the_cut": "One short phrase: why this beat other candidates today (e.g. 'most-engaged post from Karpathy this week' or 'only real model release today').",
      "signal": "exactly one emoji, no label text: 🔴 or 🟡 or 🟢 or 💡",
      "urls": ["url1"],
      "handle": "x handle if applicable, else empty string"
    }
  ],
  "build_this": [
    {
      "name": "Tool, repo, or technique name",
      "source": "GitHub / Hacker News / etc",
      "what_it_is": "One sentence, plain, what it does.",
      "why_try_it": "1-2 sentences — concretely what Pedro could do with this THIS WEEK for the agency, the yoga platform, or a micro-SaaS experiment.",
      "url": "link"
    }
  ],
  "podcasts": [
    {
      "show": "Show Name",
      "episode": "Episode Title",
      "takeaway": "Single sentence. The ONE thing Pedro needs to know.",
      "key_points": ["Point 1", "Point 2", "Point 3 (optional)"],
      "for_you": "1-2 sentences, specific, swap-test applies.",
      "signal": "exactly one emoji, no label text: 🔴 or 🟡 or 🟢 or 💡",
      "url": "episode url"
    }
  ],
  "tech": [
    {
      "name": "Person or source name",
      "role": "Title · Company or RSS source",
      "hook": "One punchy sentence, max 15 words.",
      "key_point": "One concrete supporting fact or detail, not vibes.",
      "for_you": "1 sentence, specific to Pedro building/selling AI products.",
      "signal": "exactly one emoji, no label text: 🔴 or 🟡 or 🟢 or 💡",
      "urls": ["url1"]
    }
  ],
  "pt_news": [
    { "headline": "Max 12 words", "hook": "One sentence.", "for_you": "1 sentence, specific to building in Portugal.", "signal": "🔴|🟡|🟢|💡", "url": "...", "source_name": "..." }
  ],
  "world_news": [
    { "headline": "Max 12 words", "hook": "One sentence.", "for_you": "1 sentence.", "signal": "🔴|🟡|🟢|💡", "url": "...", "source_name": "..." }
  ],
  "since_yesterday": "1-2 sentences, only if something genuinely developed from a story shown in the last 7 days. Omit the key entirely if nothing has continued."
}

RULES:
- Include only sections that have actual content. Omit empty arrays entirely.
- ai: this is the CORE section, be generous here — 5 to 8 entries when the sources support it. Prioritize actual news (model releases, technique breakthroughs, notable launches) over generic takes. One X builder's best tweet = one entry; do not create an entry for a builder whose tweets are trivial today, skip them instead of padding.
- build_this: pick 2-3 the MOST concretely actionable items from the BUILD_THIS_CANDIDATES section — favor things Pedro could actually try or ship from this week, not just interesting reads. If nothing is genuinely actionable, return an empty array rather than forcing it.
- COMMUNITY_SIGNAL (only when present): a /last30days sweep ranking topics by real interaction counts across Reddit, Hacker News, GitHub and Polymarket. This is the only Reddit signal in the whole feed, so mine it. Its topic LABELS are machine-extracted and frequently mangled: never print a label verbatim, read Why/Evidence and write a proper name yourself. Fold the good ones into ai and build_this, never create a separate section. Cite an evidence URL, and when the engagement numbers are strong cite them in why_it_made_the_cut.
- tech, pt_news, world_news: exactly 5 items each (fewer only if the sources genuinely don't have 5 distinct stories today). Pick the 5 most important/relevant. Still scannable, but each item should carry a real supporting detail, not just a headline.
- Never repeat a story already in ALREADY COVERED unless it has genuinely developed — then say what's new in for_you, and consider using since_yesterday.
- Deduplicate the same underlying story across multiple sources — pick the best single version, cite the best source.
- hook/insights: punchy, present tense, no jargon, no "X announced that Y" — write "X does Y".
- Bold key phrases with **double asterisks** — max 2 per bullet.
- for_you fields are the most important field in the whole digest. Every one must pass the swap test. Never write generic advice ("consider using AI to..."). If you can't be specific, omit the sentence or say there's no direct action.
- signal: 🟢 apply right now, 🔴 threat or disruption, 🟡 trend to monitor, 💡 concept to learn.
- Never pad, never write "In conclusion", never summarize what you just said.
- Write in Portuguese ONLY for pt_news items' hook/for_you if the source material is in Portuguese and the story is Portugal-specific; otherwise write in English. Never use em dashes, use commas or colons instead.`;

  const userPrompt = `Today: ${today}

Produce the JSON digest for these sources:

${sections.join('\n\n')}${memoryBlock}`;

  // REMIX_DRY_RUN=1 prints the assembled prompt and stops before the API call.
  // Used to diff what the model actually sees with and without an optional
  // enrichment stage, without spending a Sonnet call or touching digest-draft.
  if (process.env.REMIX_DRY_RUN === '1') {
    process.stdout.write(userPrompt + '\n');
    process.stderr.write(`remix-digest: dry run, ${sections.length} sections, no API call\n`);
    process.exit(0);
  }

  process.stderr.write(`remix-digest: sections built (${sections.length}), errors=${JSON.stringify(data.health || {})}, calling ${MODEL}...\n`);

  // If all sources failed and we have nothing to summarise, write a fallback digest
  // so generate-slides still has valid input and the pipeline doesn't crash.
  if (sections.length === 0) {
    process.stderr.write('remix-digest: no content sections — emitting fallback digest\n');
    const fallback = { date: today, ai: [], build_this: [], podcasts: [], tech: [], pt_news: [], world_news: [], _fallback: true };
    fs.writeFileSync(DRAFT_PATH, JSON.stringify(fallback, null, 2));
    process.stdout.write(JSON.stringify(fallback) + '\n');
    process.exit(0);
  }

  let remixed;
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });

    if (msg.stop_reason === 'max_tokens') {
      process.stderr.write('remix-digest: warning — response hit max_tokens, output may be truncated\n');
    }
    const textBlock = msg.content.find(b => b.type === 'text');
    const responseText = textBlock?.text;
    process.stderr.write(`remix-digest: response length=${responseText?.length}\n`);
    remixed = extractJSON(responseText);
  } catch (e) {
    process.stderr.write(`remix-digest: error — ${e.message}\n${e.stack || ''}\n`);
    process.exit(1);
  }

  // Enrich every card type with a real image (best-effort, og:image first,
  // then a Google image search fallback). This runs before video enrichment
  // so a matched Short can still take priority over the static image.
  const allEnrichable = [
    ...(remixed.pt_news || []), ...(remixed.world_news || []),
    ...(remixed.ai || []), ...(remixed.tech || []),
  ];
  if (allEnrichable.length > 0) {
    process.stderr.write(`remix-digest: enriching ${allEnrichable.length} items with images...\n`);
    await Promise.all(allEnrichable.map(enrichNewsItem));
    const withImage = allEnrichable.filter(i => i.image).length;
    process.stderr.write(`remix-digest: enriched ${withImage}/${allEnrichable.length} with image\n`);
  }

  // Attach handle from original X data (model may omit it)
  const allXAccounts = [...xAI, ...xTech];
  function attachHandle(entries) {
    return (entries || []).map(e => {
      if (e.handle) return e;
      const firstUrl = (e.urls || [])[0] || '';
      const match = firstUrl.match(/x\.com\/([^/]+)\/status/);
      return match ? { ...e, handle: match[1] } : e;
    });
  }

  const output = {
    date: today,
    ai:          attachHandle(remixed.ai)   || [],
    build_this:  remixed.build_this  || [],
    podcasts:    remixed.podcasts    || [],
    tech:        attachHandle(remixed.tech) || [],
    pt_news:     remixed.pt_news     || [],
    world_news:  remixed.world_news  || [],
    since_yesterday: remixed.since_yesterday || null,
    health: data.health || null,
  };

  const videoStats = await enrichVideos(output, process.env.YOUTUBE_API_KEY);
  process.stderr.write(`remix-digest: video enrichment ${videoStats.found}/${videoStats.attempted}\n`);

  fs.writeFileSync(DRAFT_PATH, JSON.stringify(output, null, 2));
  process.stderr.write(`remix-digest: draft written to ${DRAFT_PATH}\n`);

  await saveState(REPO_ROOT, state, today, output);
  process.stderr.write('remix-digest: state/seen.json updated\n');

  process.stdout.write(JSON.stringify(output) + '\n');
});
