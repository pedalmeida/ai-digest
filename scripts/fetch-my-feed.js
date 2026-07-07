#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import Parser from 'rss-parser';

const X_API_BASE = 'https://api.x.com/2';
const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const SOURCES_PATH = join(SCRIPT_DIR, 'my-sources.json');
const OUTPUT_PATH = join(SCRIPT_DIR, '..', 'my-feed.json');
const MAX_TWEETS_PER_USER = 10;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_WAIT_MS = 90_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function warning(message) {
  process.stderr.write(`fetch-my-feed: ${message}\n`);
}

// ── Health tracking ────────────────────────────────────────────────
// Every source class reports ok/fail counts so remix + Telegram can tell
// a healthy run from a degraded one instead of just checking exit code.
const health = {
  x: { attempted: 0, ok: 0, errors: [] },
  podcasts: { attempted: 0, ok: 0, errors: [] },
  rss: { attempted: 0, ok: 0, errors: [] },
  hackernews: { attempted: 0, ok: 0, errors: [] },
  github_trending: { attempted: 0, ok: 0, errors: [] },
};

async function readSources() {
  const raw = await readFile(SOURCES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    x_accounts: Array.isArray(parsed.x_accounts) ? parsed.x_accounts : [],
    podcasts: Array.isArray(parsed.podcasts) ? parsed.podcasts : [],
    rss_feeds: Array.isArray(parsed.rss_feeds) ? parsed.rss_feeds : []
  };
}

// ── RSS ──────────────────────────────────────────────────────────────
async function fetchOneRSS(parser, feed) {
  health.rss.attempted += 1;
  try {
    const response = await fetch(feed.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'ai-digest/1.0 (+https://pealmeida.com)' },
      redirect: 'follow'
    });
    if (!response.ok) {
      warning(`rss: ${feed.name}: HTTP ${response.status}`);
      health.rss.errors.push(`${feed.name}: HTTP ${response.status}`);
      return null;
    }
    const xml = await response.text();
    const result = await parser.parseString(xml);
    const items = (result.items || []).slice(0, 5).map(item => ({
      title: item.title || '',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || '',
      contentSnippet: (item.contentSnippet || item.summary || item.content || '').slice(0, 600)
    }));
    warning(`rss: fetched ${items.length} items from ${feed.name}`);
    health.rss.ok += 1;
    return {
      source: 'rss',
      feed_name: feed.name,
      category: feed.category,
      weight: feed.weight || 1,
      items
    };
  } catch (err) {
    warning(`rss: failed to fetch ${feed.name}: ${err.message}`);
    health.rss.errors.push(`${feed.name}: ${err.message}`);
    return null;
  }
}

async function fetchRSSFeeds(rssFeeds) {
  const parser = new Parser();
  const results = await Promise.allSettled(
    rssFeeds.map(feed => fetchOneRSS(parser, feed))
  );
  return results
    .map(r => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean);
}

// ── X (Twitter) ──────────────────────────────────────────────────────
async function fetchJson(url, bearerToken, options = {}) {
  const { retries = 2 } = options;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      return response.json();
    }

    if (!RETRYABLE_STATUS.has(response.status)) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`);
    }

    if (attempt === retries) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`);
    }

    const resetAt = Number(response.headers.get('x-rate-limit-reset') || 0) * 1000;
    const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
    const rawWait = Math.max(
      retryAfter,
      resetAt > Date.now() ? resetAt - Date.now() : 0,
      response.status === 429 ? 30_000 : 2_000 * (attempt + 1)
    );
    const waitMs = Math.min(rawWait, MAX_RATE_LIMIT_WAIT_MS);

    warning(`rate limit/server error for ${url} (${response.status}), waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  throw new Error(`unexpected fetch failure for ${url}`);
}

async function lookupUser(handle, bearerToken) {
  const url = `${X_API_BASE}/users/by/username/${encodeURIComponent(handle)}?user.fields=name,description`;
  const data = await fetchJson(url, bearerToken);
  if (!data?.data?.id) {
    throw new Error('user lookup returned no data');
  }
  return data.data;
}

async function fetchTweets(userId, handle, bearerToken) {
  const params = new URLSearchParams({
    max_results: String(MAX_TWEETS_PER_USER),
    'tweet.fields': 'created_at,public_metrics',
    exclude: 'retweets,replies'
  });
  const url = `${X_API_BASE}/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`;
  const data = await fetchJson(url, bearerToken);
  return (data.data || []).map(tweet => ({
    id: tweet.id,
    text: tweet.text,
    created_at: tweet.created_at,
    createdAt: tweet.created_at,
    url: `https://x.com/${handle}/status/${tweet.id}`,
    metrics: {
      like_count: tweet.public_metrics?.like_count || 0,
      retweet_count: tweet.public_metrics?.retweet_count || 0,
      reply_count: tweet.public_metrics?.reply_count || 0,
      quote_count: tweet.public_metrics?.quote_count || 0,
      bookmark_count: tweet.public_metrics?.bookmark_count || 0,
      impression_count: tweet.public_metrics?.impression_count || 0
    },
    likes: tweet.public_metrics?.like_count || 0,
    retweets: tweet.public_metrics?.retweet_count || 0,
    replies: tweet.public_metrics?.reply_count || 0
  }));
}

async function fetchXAccounts(accounts, bearerToken) {
  const x = [];
  if (!bearerToken) {
    warning('X_BEARER_TOKEN not set — skipping X fetch');
    return x;
  }

  for (const account of accounts) {
    const handle = String(account.handle || '').trim().replace(/^@+/, '');
    if (!handle) {
      warning('skipping account with empty handle');
      continue;
    }

    health.x.attempted += 1;
    try {
      const user = await lookupUser(handle, bearerToken);
      const tweets = await fetchTweets(user.id, handle, bearerToken);

      x.push({
        source: 'x',
        name: account.name || user.name || handle,
        handle,
        category: account.category,
        bio: user.description || '',
        tweets
      });
      health.x.ok += 1;

      await sleep(250);
    } catch (error) {
      const message = `@${handle}: ${error.message}`;
      health.x.errors.push(message);
      warning(`skipping ${message}`);
    }
  }

  return x;
}

// ── Podcasts — YouTube channel/playlist RSS, no API key needed ─────
// Discovery uses the public feeds.youtube.com Atom feed (free, no quota).
// We do NOT fetch transcripts (Supadata key not configured) — the episode
// title + media:description is enough signal for the synthesis step to
// write a useful summary; a future pass can add transcript enrichment
// once a Supadata key exists.
function parseYouTubeAtom(xml) {
  const entries = [];
  const entryBlocks = xml.split('<entry>').slice(1);
  for (const block of entryBlocks) {
    const videoId = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (block.match(/<title>([^<]*)<\/title>/) || [])[1];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];
    const description = (block.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1];
    if (videoId) {
      entries.push({
        videoId,
        title: decodeXmlEntities(title || 'Untitled'),
        publishedAt: published || null,
        description: decodeXmlEntities((description || '').slice(0, 1500))
      });
    }
  }
  return entries;
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function fetchPodcasts(podcastSources) {
  const podcasts = [];
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const podcast of podcastSources) {
    health.podcasts.attempted += 1;
    try {
      const feedUrl = podcast.playlistId
        ? `https://www.youtube.com/feeds/videos.xml?playlist_id=${podcast.playlistId}`
        : `https://www.youtube.com/feeds/videos.xml?channel_id=${podcast.channelId}`;

      const res = await fetch(feedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        warning(`podcasts: ${podcast.name}: HTTP ${res.status}`);
        health.podcasts.errors.push(`${podcast.name}: HTTP ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const entries = parseYouTubeAtom(xml);
      const recent = entries.filter(e => !e.publishedAt || new Date(e.publishedAt) >= cutoff);

      if (recent.length === 0) {
        warning(`podcasts: ${podcast.name}: no episodes within lookback window`);
        health.podcasts.errors.push(`${podcast.name}: no recent episodes`);
        continue;
      }

      const latest = recent[0];
      podcasts.push({
        source: 'podcast',
        name: podcast.name,
        title: latest.title,
        url: `https://youtube.com/watch?v=${latest.videoId}`,
        publishedAt: latest.publishedAt,
        description: latest.description,
        transcript: '' // no Supadata key configured; description-only summary
      });
      health.podcasts.ok += 1;
    } catch (err) {
      warning(`podcasts: error processing ${podcast.name}: ${err.message}`);
      health.podcasts.errors.push(`${podcast.name}: ${err.message}`);
    }
  }

  return podcasts;
}

// ── Hacker News — points-ranked, AI/dev-tools filtered ──────────────
const HN_KEYWORDS = /\b(ai|llm|gpt|claude|anthropic|openai|gemini|model|agent|ml|neural|transformer|copilot|coding|dev ?tool)\b/i;
const HN_MIN_POINTS = 80;
const HN_MAX_ITEMS = 8;
const HN_CANDIDATE_POOL = 60;

async function fetchHackerNews() {
  health.hackernews.attempted += 1;
  try {
    const idsRes = await fetch(`${HN_API_BASE}/topstories.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!idsRes.ok) throw new Error(`topstories HTTP ${idsRes.status}`);
    const ids = (await idsRes.json()).slice(0, HN_CANDIDATE_POOL);

    const items = await Promise.allSettled(
      ids.map(id => fetch(`${HN_API_BASE}/item/${id}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then(r => r.json()))
    );

    const stories = items
      .map(r => (r.status === 'fulfilled' ? r.value : null))
      .filter(Boolean)
      .filter(s => s.title && s.url && (s.score || 0) >= HN_MIN_POINTS)
      .filter(s => HN_KEYWORDS.test(s.title))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, HN_MAX_ITEMS)
      .map(s => ({
        title: s.title,
        link: s.url,
        points: s.score,
        comments: s.descendants || 0,
        discussionUrl: `https://news.ycombinator.com/item?id=${s.id}`
      }));

    warning(`hackernews: ${stories.length} AI/dev-tool stories above ${HN_MIN_POINTS}pt threshold`);
    health.hackernews.ok += 1;
    return stories;
  } catch (err) {
    warning(`hackernews: failed: ${err.message}`);
    health.hackernews.errors.push(err.message);
    return [];
  }
}

// ── GitHub trending — unofficial HTML scrape, defensive parsing ────
// No official API for trending exists. If GitHub changes markup this
// returns [] rather than throwing — it must never be able to take down
// the run.
const GH_MAX_REPOS = 8;

async function fetchGithubTrending() {
  health.github_trending.attempted += 1;
  try {
    const res = await fetch('https://github.com/trending?since=daily&spoken_language_code=en', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-digest/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const rows = html.split('Box-row').slice(1);
    const repos = [];
    for (const row of rows.slice(0, 25)) {
      const path = (row.match(/href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"\s+data-hydro-click/) || [])[1]
        || (row.match(/<h2[^>]*>[\s\S]*?href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"/) || [])[1];
      const descMatch = row.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/p>/);

      if (!path) continue;
      repos.push({
        repo: path,
        url: `https://github.com/${path}`,
        description: decodeXmlEntities((descMatch?.[1] || '').replace(/<[^>]+>/g, '').trim())
      });
    }

    const deduped = repos.filter((r, i) => repos.findIndex(x => x.repo === r.repo) === i).slice(0, GH_MAX_REPOS);
    warning(`github_trending: ${deduped.length} repos scraped`);
    if (deduped.length > 0) health.github_trending.ok += 1;
    else health.github_trending.errors.push('parsed 0 repos — markup may have changed');
    return deduped;
  } catch (err) {
    warning(`github_trending: failed: ${err.message}`);
    health.github_trending.errors.push(err.message);
    return [];
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const bearerToken = process.env.X_BEARER_TOKEN;
  const sources = await readSources();

  const [x, podcasts, rss, hackernews, githubTrending] = await Promise.all([
    fetchXAccounts(sources.x_accounts, bearerToken),
    fetchPodcasts(sources.podcasts || []),
    fetchRSSFeeds(sources.rss_feeds || []),
    fetchHackerNews(),
    fetchGithubTrending(),
  ]);

  const output = {
    generatedAt: new Date().toISOString(),
    x,
    podcasts,
    rss,
    hackernews,
    githubTrending,
    health,
    stats: {
      xBuilders: x.length,
      totalTweets: x.reduce((sum, account) => sum + account.tweets.length, 0),
      podcastEpisodes: podcasts.length,
      rssFeeds: rss.length,
      hackernewsStories: hackernews.length,
      githubRepos: githubTrending.length,
    },
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const summary = Object.entries(health)
    .map(([k, v]) => `${k}=${v.ok}/${v.attempted}`)
    .join(' ');
  warning(`done: ${summary}`);
}

main().catch(error => {
  process.stderr.write(`fetch-my-feed: fatal: ${error.message}\n`);
  process.exit(1);
});
