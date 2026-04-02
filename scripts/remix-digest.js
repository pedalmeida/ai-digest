#!/usr/bin/env node
/**
 * remix-digest.js
 * Reads prepare-digest.js JSON from stdin.
 * Calls Claude API to produce structured, scannable digest content
 * tailored for a busy founder/PM who needs actionable takeaways.
 * Outputs structured JSON to stdout for generate-slides.js.
 *
 * Required env: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Load .env
const envPath = path.join(os.homedir(), '.follow-builders', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
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
  catch (e) { process.stderr.write('remix-digest: invalid JSON\n'); process.exit(1); }

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const xBuilders = (data.x || []).filter(b =>
    (b.tweets || []).some(t => t.text?.trim().length > 15)
  );
  const podcasts = data.podcasts || [];

  // ── Build source sections ─────────────────────────────────────
  const sections = [];

  xBuilders.forEach((b, i) => {
    const bio = (b.bio || '').replace(/\s+/g, ' ').trim();
    const tweets = (b.tweets || [])
      .filter(t => t.text?.trim().length > 15)
      .slice(0, 4)
      .map(t => `  • TEXT: ${t.text.replace(/https?:\/\/t\.co\/\S+/g, '').trim()}\n    URL: ${t.url || ''}`)
      .join('\n');
    sections.push(`=== BUILDER ${i + 1}: ${b.name || b.handle} ===\nBio: ${bio}\nTweets:\n${tweets}`);
  });

  podcasts.forEach((p, i) => {
    sections.push(`=== PODCAST ${i + 1}: ${p.name} ===\nTitle: ${p.title}\nURL: ${p.url}\nTranscript:\n${(p.transcript || '').slice(0, 5000)}`);
  });

  // ── Prompt ────────────────────────────────────────────────────
  const systemPrompt = `You are the executive assistant and chief curator for Pedro, a Portuguese entrepreneur and product builder.

Pedro's profile:
- Building an early-stage AI startup as a non-technical founder
- Product Manager background with UX and strategy experience
- Learning to be technically fluent in AI — curious, not expert
- Active projects: new business, AMURT Portugal (NGO website), yoga/meditation platform, Baba GPT (RAG chatbot)
- Wants to apply AI tools practically to build real products faster

Your job: Transform raw builder content into a SCANNABLE EXECUTIVE BRIEF.
Pedro has 90 seconds per slide. Every word must earn its place.

OUTPUT FORMAT — respond ONLY with valid JSON, no markdown fences:

{
  "builders": [
    {
      "name": "Full Name",
      "role": "Title · Company",
      "hook": "One punchy sentence. What happened. Why it matters. Max 15 words.",
      "insights": [
        "First key insight — specific, concrete, no filler",
        "Second key insight — what's new or surprising",
        "Third key insight (optional) — implication or signal"
      ],
      "for_you": "2-3 sentences max. Speak directly to Pedro. Start with the action or implication. Example: 'As you build [X], this means...' or 'Watch this pattern — it's exactly what you need for...' Be specific to his projects when relevant.",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "urls": ["url1", "url2"]
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
      "for_you": "2-3 sentences. What does this mean for Pedro specifically? Reference his projects or stage when relevant. What should he do or think differently about?",
      "signal": "one of: 🔴 urgent | 🟡 watch | 🟢 apply now | 💡 learn",
      "url": "episode url"
    }
  ]
}

RULES:
- hook: punchy, present tense, no jargon. "X does Y" not "X announced that Y"
- insights: start each with a strong verb or concrete noun. No "he said that". Just the fact.
- Bold key phrases by wrapping them in **double asterisks** — use sparingly, max 2 per bullet
- for_you: this is the most important section. Be a trusted advisor, not a journalist. Pedro should feel like someone who actually knows his situation wrote this.
- signal: use 🟢 for things Pedro can apply to current projects, 🔴 for things that could threaten or disrupt, 🟡 for trends to monitor, 💡 for concepts worth learning
- Never pad. Never summarize what you just said. No "In conclusion".`;

  const userPrompt = `Today: ${today}

Produce the JSON digest for these sources:

${sections.join('\n\n')}`;

  let remixed;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    const text = msg.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    remixed = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`remix-digest: API error — ${e.message}\n`);
    process.exit(1);
  }

  // ── Merge with original data ──────────────────────────────────
  const output = {
    date: today,
    builders: (remixed.builders || []).map((b, i) => {
      const orig = xBuilders[i] || {};
      const firstUrl = (orig.tweets || [])[0]?.url || '';
      const handle = (firstUrl.match(/x\.com\/([^/]+)\/status/) || [])[1] || '';
      return {
        name:     b.name,
        role:     b.role,
        hook:     b.hook,
        insights: b.insights || [],
        for_you:  b.for_you,
        signal:   b.signal || '🟡',
        urls:     (b.urls || []).filter(Boolean),
        handle,
        index:    i + 1,
      };
    }),
    podcasts: (remixed.podcasts || []).map((p, i) => {
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
        index:      (remixed.builders || []).length + i + 1,
      };
    }),
  };

  process.stdout.write(JSON.stringify(output) + '\n');
});
