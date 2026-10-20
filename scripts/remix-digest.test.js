import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON } from './json-extract.js';

test('extracts JSON from a fenced model response', () => {
  assert.deepEqual(extractJSON('```json\n{"ok":true}\n```'), { ok: true });
});

test('rejects an incomplete model response so the caller can retry compactly', () => {
  assert.throws(() => extractJSON('{"items":[{"title":"unfinished"}'), /No complete JSON object/);
});
