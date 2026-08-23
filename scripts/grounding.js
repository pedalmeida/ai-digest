import { normalizeUrl } from './digest-state.js';

const DIGEST_SECTIONS = ['ai', 'build_this', 'podcasts', 'tech', 'pt_news', 'world_news'];
const SOURCE_URL_KEYS = new Set(['url', 'link', 'discussionUrl']);

export function collectSourceUrls(value, key = '') {
  const urls = new Set();

  function visit(current, currentKey) {
    if (Array.isArray(current)) {
      for (const item of current) visit(item, currentKey);
      return;
    }
    if (current && typeof current === 'object') {
      for (const [childKey, childValue] of Object.entries(current)) visit(childValue, childKey);
      return;
    }
    if (typeof current === 'string' && SOURCE_URL_KEYS.has(currentKey)) {
      const normalized = normalizeUrl(current);
      if (normalized) urls.add(normalized);
    }
  }

  visit(value, key);
  return urls;
}

export function filterUngroundedDigest(digest, sourceData) {
  const allowed = collectSourceUrls(sourceData);
  const filtered = { ...digest };
  let removed = 0;

  for (const section of DIGEST_SECTIONS) {
    if (!Array.isArray(digest[section])) continue;

    filtered[section] = digest[section].flatMap(item => {
      if (Array.isArray(item.urls)) {
        const urls = item.urls.filter(url => allowed.has(normalizeUrl(url)));
        if (urls.length === 0) {
          removed += 1;
          return [];
        }
        return [{ ...item, urls }];
      }

      if (typeof item.url === 'string' && allowed.has(normalizeUrl(item.url))) {
        return [item];
      }

      removed += 1;
      return [];
    });
  }

  return { digest: filtered, removed };
}
