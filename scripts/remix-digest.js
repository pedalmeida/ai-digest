#!/usr/bin/env node
/**
 * remix-digest.js
 * Reads prepare-digest.js JSON from stdin.
 * Calls Claude API to interpret/summarize each builder and podcast
 * using the skill's own prompts (same quality as the Telegram output).
 * Outputs a remixed JSON to stdout for generate-slides.js to render.
 *
 * Required env: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Load .env from ~/.follow-builders/.env if present
const envPath = path.join(os.homedir(), '.follow-builders', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { process.stderr.write('remix-digest: invalid JSON from prepare-digest\n'); process.exit(1); }

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompts = data.prompts || {};
  const xBuilders = (data.x || []).filter(b => (b.tweets || []).some(t => t.text?.trim().length > 15));
  const podcasts = data.podcasts || [];

  // ── Build one batched prompt for all builders + podcasts ───────
  const sections = [];

  xBuilders.forEach((b, i) => {
    const bio = (b.bio || '').replace(/\s+/g, ' ').trim();
    const tweets = b.tweets
      .filter(t => t.text?.trim().length > 15)
      .slice(0, 4)
      .map(t => `- TEXT: ${t.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()}\n  URL: ${t.url || ''}`)
      .join('\n');

    sections.push(`=== BUILDER ${i + 1}: ${b.name || b.handle} ===
Bio: ${bio}
Tweets:
${tweets}`);
  });

  podcasts.forEach((p, i) => {
    const transcript = (p.transcript || '').slice(0, 6000);
    sections.push(`=== PODCAST ${i + 1}: ${p.name} ===
Title: ${p.title}
URL: ${p.url}
Transcript excerpt:
${transcript}`);
  });

  const systemPrompt = `You are an expert AI content curator writing a daily digest for busy founders and PMs.
Your job: interpret and summarize AI builder content — not copy-paste it.
Every summary must be:
- Concise (2-4 sentences max per builder)
- Actionable and insightful — what does this MEAN for builders?
- Written in third person, present tense
- Include the person's full name and role at the start (e.g. "Replit CEO Amjad Masad")
- Do NOT copy raw tweet text verbatim. Interpret and synthesize.

${prompts.summarize_tweets || ''}

${prompts.summarize_podcast || ''}

Respond ONLY with valid JSON in this exact format:
{
  "builders": [
    {
      "name": "Full Name",
      "role": "Role at Company",
      "summary": "2-4 sentence interpreted summary",
      "urls": ["url1", "url2"]
    }
  ],
  "podcasts": [
    {
      "show": "Show Name",
      "episode": "Episode Title",
      "takeaway": "One sentence — the single most important insight",
      "summary": "3-5 sentence summary of key ideas and why they matter",
      "url": "episode url"
    }
  ]
}`;

  const userPrompt = `Today's date: ${today}

Summarize each of the following builders and podcasts according to the format above.
Return ONLY the JSON — no prose, no markdown fences.

${sections.join('\n\n')}`;

  let remixed;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    const text = msg.content[0].text.trim();
    // Strip markdown fences if model adds them
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    remixed = JSON.parse(jsonStr);
  } catch (e) {
    process.stderr.write(`remix-digest: API error — ${e.message}\n`);
    process.exit(1);
  }

  // ── Merge with original data to keep URLs and video IDs ───────
  const output = {
    date: today,
    builders: (remixed.builders || []).map((b, i) => {
      const orig = xBuilders[i] || {};
      const firstUrl = (orig.tweets || [])[0]?.url || '';
      const handle = (firstUrl.match(/x\.com\/([^/]+)\/status/) || [])[1] || '';
      return {
        name:    b.name,
        role:    b.role,
        summary: b.summary,
        urls:    b.urls?.filter(Boolean) || orig.tweets?.map(t => t.url).filter(Boolean) || [],
        handle,
        index:   i + 1,
      };
    }),
    podcasts: (remixed.podcasts || []).map((p, i) => {
      const orig = podcasts[i] || {};
      const videoId = (orig.url || '').match(/(?:v=|youtu\.be\/)([^&\s]+)/)?.[1] || '';
      return {
        show:     p.show || orig.name,
        episode:  p.episode || orig.title,
        takeaway: p.takeaway,
        summary:  p.summary,
        url:      p.url || orig.url,
        videoId,
        index:    (remixed.builders || []).length + i + 1,
      };
    }),
  };

  process.stdout.write(JSON.stringify(output) + '\n');
});
