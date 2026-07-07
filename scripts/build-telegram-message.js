#!/usr/bin/env node
/**
 * build-telegram-message.js
 * Reads digest-draft.json and prints a Telegram message (Markdown) to stdout:
 * top 3 AI headlines, a Build-this teaser, a source health line, and the link.
 * The workflow pipes this straight into the Telegram sendMessage curl call.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAFT_PATH = path.join(__dirname, '..', 'digest-draft.json');

function stripMd(str) {
  return String(str || '').replace(/\*\*/g, '');
}

function healthLine(health) {
  if (!health) return null;
  const parts = [];
  const degraded = [];
  const labels = { x: 'X', podcasts: 'Podcasts', rss: 'RSS', hackernews: 'HN', github_trending: 'GitHub' };
  for (const [key, v] of Object.entries(health)) {
    if (v.attempted === 0) continue; // not configured, not a failure
    const label = labels[key] || key;
    parts.push(`${label} ${v.ok}/${v.attempted}`);
    if (v.ok / v.attempted < 0.5) degraded.push(label);
  }
  return { summary: parts.join(', '), degraded };
}

function main() {
  if (!fs.existsSync(DRAFT_PATH)) {
    process.stdout.write('⚠️ Digest generated but draft file missing, check the run.\n');
    process.exit(0);
  }
  const data = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));

  if (data._fallback) {
    process.stdout.write('⚠️ Daily Digest ran but every source failed. Check the run: https://github.com/pedalmeida/ai-digest/actions\n');
    process.exit(0);
  }

  const lines = [];
  const health = healthLine(data.health);
  const isDegraded = health && health.degraded.length > 0;

  lines.push(isDegraded ? '⚠️ Your Daily Digest is ready (degraded run)' : '☀️ Your Daily Digest is ready');
  lines.push('');

  const topAi = (data.ai || []).slice(0, 3);
  if (topAi.length > 0) {
    lines.push('🤖 AI today:');
    for (const item of topAi) {
      lines.push(`• ${stripMd(item.hook)}`);
    }
    lines.push('');
  }

  const build = (data.build_this || [])[0];
  if (build) {
    lines.push(`🛠️ Build this: ${build.name}, ${stripMd(build.what_it_is)}`);
    lines.push('');
  }

  if (health) {
    lines.push(`Sources: ${health.summary}${isDegraded ? ` — degraded: ${health.degraded.join(', ')}` : ''}`);
    lines.push('');
  }

  lines.push('Full brief: https://pealmeida.com/projects/ai-digest/');

  process.stdout.write(lines.join('\n') + '\n');
}

main();
