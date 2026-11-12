#!/usr/bin/env node
/**
 * build-telegram-message.js
 * Reads digest-draft.json and prints the Slack #feed card (mrkdwn) to stdout:
 * verdict line, top 3 AI headlines, a Build-this teaser and the link to the full brief.
 * The workflow posts it with chat.postMessage.
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
    process.stdout.write('⚠️ *Digest de IA* · Falhou: o digest correu mas não ficou guardado.\n👉 Vitruvius vê a corrida.\n');
    process.exit(0);
  }
  const data = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));

  if (data._fallback) {
    process.stdout.write('⚠️ *Digest de IA* · Falhou: nenhuma fonte respondeu hoje.\n_Detalhe_ 👉 <https://github.com/pedalmeida/ai-digest/actions|ver a corrida>\n');
    process.exit(0);
  }

  // Executive card for Slack #feed (Pedro, 2026-11-12): verdict first, max 3 bullets,
  // detail one click away on the reading page. Same shape as every other #feed post.
  const lines = [];
  const health = healthLine(data.health);
  const isDegraded = health && health.degraded.length > 0;
  const clean = s => stripMd(s).replace(/\s*[—–]\s*/g, ', ').trim();
  const topAi = (data.ai || []).slice(0, 3);

  lines.push(isDegraded
    ? `⚠️ *Digest de IA* · Pronto, mas sem a fonte ${health.degraded.join(', ')}: ${topAi.length} destaques`
    : `☀️ *Digest de IA* · Tudo ok: ${topAi.length} destaques de hoje`);
  for (const item of topAi) lines.push(`• ${clean(item.hook)}`);

  const build = (data.build_this || [])[0];
  if (build) lines.push(`🛠️ Para construir: ${clean(build.name)}`);

  lines.push('_Detalhe no digest_ 👉 <https://pealmeida.com/projects/ai-digest/|ler completo>');

  process.stdout.write(lines.join('\n') + '\n');
}

main();
