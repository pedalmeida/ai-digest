import assert from 'node:assert/strict';
import test from 'node:test';
import { filterUngroundedDigest } from './grounding.js';

const sourceData = {
  rss: [{ items: [{ link: 'https://example.com/story?utm_source=digest' }] }],
  githubTrending: [{ url: 'https://github.com/example/tool' }],
};

test('keeps citations that normalize to a source URL', () => {
  const result = filterUngroundedDigest({
    pt_news: [{ headline: 'Story', url: 'https://example.com/story' }],
  }, sourceData);

  assert.equal(result.removed, 0);
  assert.equal(result.digest.pt_news.length, 1);
});

test('removes an item whose only citation is absent from the sources', () => {
  const result = filterUngroundedDigest({
    build_this: [{ name: 'Invented', url: 'https://cursor.com' }],
  }, sourceData);

  assert.equal(result.removed, 1);
  assert.deepEqual(result.digest.build_this, []);
});

test('keeps an item but strips unsupported URLs when one citation is grounded', () => {
  const result = filterUngroundedDigest({
    ai: [{ hook: 'Real story', urls: ['https://example.com/story', 'https://invented.example'] }],
  }, sourceData);

  assert.equal(result.removed, 0);
  assert.deepEqual(result.digest.ai[0].urls, ['https://example.com/story']);
});

test('removes items without a citation', () => {
  const result = filterUngroundedDigest({
    tech: [{ hook: 'No source' }],
  }, sourceData);

  assert.equal(result.removed, 1);
  assert.deepEqual(result.digest.tech, []);
});
