#!/usr/bin/env node

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const X_API_BASE = 'https://api.x.com/2';
const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const SOURCES_PATH = join(SCRIPT_DIR, 'my-sources.json');
const OUTPUT_PATH = join(SCRIPT_DIR, '..', 'my-feed.json');
const MAX_TWEETS_PER_USER = 10;
const PODCAST_LOOKBACK_HOURS = 336; // 14 days — podcasts publish weekly/biweekly
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function warning(message) {
  process.stderr.write(`fetch-my-feed: ${message}\n`);
}

async function readSources() {
  const raw = await readFile(SOURCES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    x_accounts: Array.isArray(parsed.x_accounts) ? parsed.x_accounts : [],
    podcasts: Array.isArray(parsed.podcasts) ? parsed.podcasts : []
  };
}

async function fetchJson(url, bearerToken, options = {}) {
  const { retries = 2 } = options;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`
      }
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
    const waitMs = Math.max(
      retryAfter,
      resetAt > Date.now() ? resetAt - Date.now() : 0,
      response.status === 429 ? 60_000 : 2_000 * (attempt + 1)
    );

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

async function fetchPodcasts(podcastSources, apiKey) {
  const podcasts = [];
  const cutoff = new Date(Date.now() - PODCAST_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const podcast of podcastSources) {
    try {
      const videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      const videosRes = await fetch(videosUrl, { headers: { 'x-api-key': apiKey } });

      if (!videosRes.ok) {
        warning(`podcasts: failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      const regularIds = videosData.videoIds || videosData.video_ids || [];
      const liveIds = videosData.liveIds || videosData.live_ids || [];
      const videoIds = [...regularIds, ...liveIds];

      // Check first 2 videos, pick newest one with a transcript
      for (const videoId of videoIds.slice(0, 2)) {
        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (!metaRes.ok) continue;

          const meta = await metaRes.json();
          const publishedAt = meta.uploadDate || meta.publishedAt || meta.date || null;

          // Skip if outside lookback window (but include if date is unknown)
          if (publishedAt && new Date(publishedAt) < cutoff) continue;

          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          const transcriptRes = await fetch(
            `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
            { headers: { 'x-api-key': apiKey } }
          );
          if (!transcriptRes.ok) continue;

          const transcriptData = await transcriptRes.json();
          const transcript = transcriptData.content || '';
          if (!transcript) continue;

          podcasts.push({
            source: 'podcast',
            name: podcast.name,
            title: meta.title || 'Untitled',
            url: `https://youtube.com/watch?v=${videoId}`,
            publishedAt,
            transcript
          });
          break; // one episode per podcast source
        } catch (err) {
          warning(`podcasts: error processing video ${videoId}: ${err.message}`);
        }
        await sleep(300);
      }
    } catch (err) {
      warning(`podcasts: error processing ${podcast.name}: ${err.message}`);
    }
  }

  return podcasts;
}

async function main() {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    process.stderr.write('fetch-my-feed: X_BEARER_TOKEN not set\n');
    process.exit(1);
  }

  const supadataKey = process.env.SUPADATA_API_KEY;

  const sources = await readSources();
  const x = [];
  const errors = [];

  for (const account of sources.x_accounts) {
    const handle = String(account.handle || '').trim().replace(/^@+/, '');
    if (!handle) {
      warning('skipping account with empty handle');
      continue;
    }

    try {
      const user = await lookupUser(handle, bearerToken);
      const tweets = await fetchTweets(user.id, handle, bearerToken);

      x.push({
        source: 'x',
        name: account.name || user.name || handle,
        handle,
        bio: user.description || '',
        tweets
      });

      await sleep(250);
    } catch (error) {
      const message = `skipping @${handle}: ${error.message}`;
      errors.push(message);
      warning(message);
    }
  }

  const podcasts = supadataKey
    ? await fetchPodcasts(sources.podcasts || [], supadataKey)
    : [];

  if (!supadataKey) {
    warning('SUPADATA_API_KEY not set — skipping podcast fetch');
  }

  const output = {
    generatedAt: new Date().toISOString(),
    x,
    podcasts,
    stats: {
      xBuilders: x.length,
      totalTweets: x.reduce((sum, account) => sum + account.tweets.length, 0),
      podcastEpisodes: podcasts.length
    },
    errors: errors.length > 0 ? errors : undefined
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
}

main().catch(error => {
  process.stderr.write(`fetch-my-feed: ${error.message}\n`);
  process.exit(1);
});
