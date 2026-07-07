// digest-state.js
// Lightweight "memory" so the digest can dedup across days and note momentum
// ("since yesterday") instead of treating every run as a blank slate.
//
// State lives at state/seen.json (repo root), committed by the daily workflow
// alongside index.html + digest-draft.json. Kept small on purpose: only
// normalized URLs/topics from the last STATE_WINDOW_DAYS, not full content.

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const STATE_WINDOW_DAYS = 7;

export function statePath(repoRoot) {
  return path.join(repoRoot, 'state', 'seen.json');
}

export async function loadState(repoRoot) {
  try {
    const raw = await readFile(statePath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.days) ? parsed : { days: [] };
  } catch {
    return { days: [] };
  }
}

// Normalize a URL for dedup: strip query/fragment/protocol so the same
// story linked with different tracking params still matches.
export function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

// Build the set of URLs already shown within the window, and a flat list of
// past headlines/hooks so the model can recognize the same story told a
// different way (not just an exact URL repeat).
export function buildSeenContext(state) {
  const cutoff = Date.now() - STATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentDays = state.days.filter(d => new Date(d.date).getTime() >= cutoff);

  const seenUrls = new Set();
  const seenHeadlines = [];
  for (const day of recentDays) {
    for (const item of day.items || []) {
      if (item.url) seenUrls.add(normalizeUrl(item.url));
      if (item.headline) seenHeadlines.push({ date: day.date, headline: item.headline });
    }
  }

  return { seenUrls, seenHeadlines, recentDays };
}

// Extract a flat list of {headline, url} from a finished digest, across all
// sections, for persisting into today's state entry.
export function extractDigestItems(digest) {
  const items = [];
  for (const key of ['pt_news', 'world_news']) {
    for (const it of digest[key] || []) {
      items.push({ headline: it.headline, url: it.url });
    }
  }
  for (const key of ['tech', 'ai']) {
    for (const it of digest[key] || []) {
      items.push({ headline: it.hook, url: (it.urls || [])[0] });
    }
  }
  for (const it of digest.build_this || []) {
    items.push({ headline: it.name, url: it.url });
  }
  for (const it of digest.podcasts || []) {
    items.push({ headline: it.episode, url: it.url });
  }
  return items.filter(it => it.headline || it.url);
}

export async function saveState(repoRoot, state, today, digest) {
  const cutoff = Date.now() - STATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const days = (state.days || []).filter(d => new Date(d.date).getTime() >= cutoff);
  days.push({ date: today, items: extractDigestItems(digest) });

  const dir = path.join(repoRoot, 'state');
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(repoRoot), JSON.stringify({ days }, null, 2));
}
