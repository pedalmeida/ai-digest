#!/usr/bin/env node
/**
 * merge-sources.js
 * Reads prepare-digest.js JSON from stdin.
 * Merges user's custom-sources.json (if present) into the feed.
 * Only adds sources that are NOT already in the central feed.
 * Outputs merged JSON to stdout.
 *
 * Custom sources file: ~/.follow-builders/custom-sources.json
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';

const customPath = path.join(os.homedir(), '.follow-builders', 'custom-sources.json');

let raw = '';
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { process.stderr.write('merge-sources: invalid JSON\n'); process.exit(1); }

  if (!fs.existsSync(customPath)) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  let custom;
  try { custom = JSON.parse(fs.readFileSync(customPath, 'utf8')); }
  catch (e) {
    process.stderr.write('merge-sources: could not parse custom-sources.json — using central feed only\n');
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  // Merge X accounts — skip duplicates by handle
  const existingHandles = new Set((data.x || []).map(b => (b.handle || b.name || '').toLowerCase()));
  const customX = (custom.x_accounts || []).filter(a => {
    const handle = (a.handle || '').toLowerCase();
    if (existingHandles.has(handle)) return false;
    existingHandles.add(handle);
    return true;
  }).map(a => ({
    name:   a.name || a.handle,
    handle: a.handle,
    bio:    a.bio || a.name || '',
    tweets: [],   // no tweets yet — central feed doesn't cover custom handles
    _custom: true
  }));

  // Merge podcasts — skip duplicates by name
  const existingPods = new Set((data.podcasts || []).map(p => (p.name || '').toLowerCase()));
  const customPods = (custom.podcasts || []).filter(p => {
    const name = (p.name || '').toLowerCase();
    if (existingPods.has(name)) return false;
    existingPods.add(name);
    return true;
  });

  if (customX.length > 0 || customPods.length > 0) {
    process.stderr.write(`merge-sources: added ${customX.length} X accounts, ${customPods.length} podcasts from custom-sources.json\n`);
  }

  data.x        = [...(data.x || []),       ...customX];
  data.podcasts = [...(data.podcasts || []), ...customPods];

  process.stdout.write(JSON.stringify(data) + '\n');
});
