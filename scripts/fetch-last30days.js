#!/usr/bin/env node

/**
 * Optional enrichment stage: merges /last30days discovery signal into my-feed.json.
 *
 * Runs AFTER fetch-my-feed.js. The engine sweeps Reddit (real upvotes + top
 * comments), Hacker News, GitHub, Polymarket and arXiv, then ranks topics by
 * cross-source velocity. Reddit and Polymarket are the signals the digest's own
 * source list has no path to.
 *
 * This stage is strictly additive and never fails the pipeline: on any error it
 * records the failure in feed.health and exits 0, leaving my-feed.json usable.
 *
 * Env:
 *   LAST30DAYS_ENABLED   "1" to run; anything else is a no-op passthrough
 *   LAST30DAYS_ENGINE    path to last30days.py (required when enabled)
 *   LAST30DAYS_DOMAINS   comma-separated discovery domains (default "AI agents")
 *   LAST30DAYS_TIMEOUT_MS  per-domain wall clock budget (default 420000)
 *   LAST30DAYS_MAX_TOPICS  topics kept per domain (default 6)
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const FEED_PATH = join(SCRIPT_DIR, '..', 'my-feed.json');
const DEFAULT_DOMAINS = 'AI agents';
const DEFAULT_TIMEOUT_MS = 420_000;
const DEFAULT_MAX_TOPICS = 6;
const SUPPORTED_SCHEMA_MAJOR = 1;

function warning(message) {
  process.stderr.write(`fetch-last30days: ${message}\n`);
}

const health = { attempted: 0, ok: 0, errors: [] };

// ── Engine invocation ──────────────────────────────────────────────
// The engine writes progress chatter to stderr and the JSON contract to
// stdout, so the two streams are captured separately and only stdout parsed.
function runEngine(enginePath, domain, timeoutMs) {
  return new Promise(resolve => {
    const args = [enginePath, '--discover', domain, '--emit=json'];
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        return resolve({ ok: false, error: `timed out after ${timeoutMs}ms` });
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-1)[0] || `exit ${code}`;
        return resolve({ ok: false, error: `engine exit ${code}: ${detail}` });
      }
      try {
        resolve({ ok: true, report: JSON.parse(stdout) });
      } catch (err) {
        resolve({ ok: false, error: `unparseable JSON: ${err.message}` });
      }
    });
  });
}

// ── Normalisation ──────────────────────────────────────────────────
// Maps the versioned discovery contract onto the flat shape remix-digest
// consumes, so a contract addition upstream cannot reshape the prompt.
function normalise(report, domain, maxTopics) {
  const schema = String(report.schema_version || '');
  const major = Number.parseInt(schema.split('.')[0], 10);
  if (Number.isFinite(major) && major !== SUPPORTED_SCHEMA_MAJOR) {
    return { skipped: `unsupported schema_version ${schema}`, topics: [] };
  }

  const all = Array.isArray(report.results) ? report.results : [];
  const kept = all.slice(0, maxTopics);
  if (all.length > kept.length) {
    warning(`${domain}: kept ${kept.length}/${all.length} topics (LAST30DAYS_MAX_TOPICS)`);
  }

  const topics = kept.map(r => ({
    topic: r.topic || '',
    whySpiking: r.why_spiking || '',
    momentum: r.momentum || null,
    velocityScore: r.velocity_score ?? null,
    sources: Array.isArray(r.sources) ? r.sources : [],
    engagement: r.engagement || null,
    corroborationCount: r.corroboration_count ?? null,
    topComment: r.top_comment || null,
    evidenceUrls: Array.isArray(r.evidence_urls) ? r.evidence_urls.slice(0, 4) : [],
    podcastAngle: r.podcast_angle || null,
  })).filter(t => t.topic);

  return {
    skipped: null,
    topics,
    outcome: report.outcome || null,
    weakSignal: report.weak_signal || null,
    sourceStatus: report.source_status || {},
    warnings: Array.isArray(report.warnings) ? report.warnings : [],
  };
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  let feed;
  try {
    feed = JSON.parse(await readFile(FEED_PATH, 'utf8'));
  } catch (err) {
    warning(`my-feed.json unreadable, nothing to enrich: ${err.message}`);
    return;
  }

  if (process.env.LAST30DAYS_ENABLED !== '1') {
    warning('disabled (LAST30DAYS_ENABLED != 1); passing feed through untouched');
    return;
  }

  const enginePath = process.env.LAST30DAYS_ENGINE;
  if (!enginePath) {
    warning('LAST30DAYS_ENABLED=1 but LAST30DAYS_ENGINE is unset; skipping');
    feed.health = { ...(feed.health || {}), last30days: { attempted: 0, ok: 0, errors: ['LAST30DAYS_ENGINE unset'] } };
    await writeFile(FEED_PATH, JSON.stringify(feed, null, 2));
    return;
  }

  const domains = (process.env.LAST30DAYS_DOMAINS || DEFAULT_DOMAINS)
    .split(',').map(d => d.trim()).filter(Boolean);
  const timeoutMs = Number(process.env.LAST30DAYS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const maxTopics = Number(process.env.LAST30DAYS_MAX_TOPICS) || DEFAULT_MAX_TOPICS;

  const sweeps = [];
  for (const domain of domains) {
    health.attempted += 1;
    const started = Date.now();
    const result = await runEngine(enginePath, domain, timeoutMs);
    const elapsed = Math.round((Date.now() - started) / 1000);

    if (!result.ok) {
      warning(`${domain}: ${result.error} (${elapsed}s)`);
      health.errors.push(`${domain}: ${result.error}`);
      continue;
    }

    const normalised = normalise(result.report, domain, maxTopics);
    if (normalised.skipped) {
      warning(`${domain}: ${normalised.skipped}`);
      health.errors.push(`${domain}: ${normalised.skipped}`);
      continue;
    }

    health.ok += 1;
    warning(`${domain}: ${normalised.topics.length} topics in ${elapsed}s (outcome=${normalised.outcome})`);
    sweeps.push({ domain, ...normalised });
  }

  feed.last30days = sweeps;
  feed.health = { ...(feed.health || {}), last30days: health };
  feed.stats = {
    ...(feed.stats || {}),
    last30daysSweeps: sweeps.length,
    last30daysTopics: sweeps.reduce((sum, s) => sum + s.topics.length, 0),
  };

  await writeFile(FEED_PATH, JSON.stringify(feed, null, 2));
  warning(`done: last30days=${health.ok}/${health.attempted}`);
}

// Enrichment is optional by design: log and exit 0 so the digest still ships.
main().catch(error => {
  warning(`non-fatal: ${error.message}`);
  process.exit(0);
});
