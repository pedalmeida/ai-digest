/**
 * Helpers for the Anthropic call in remix-digest.js.
 * Keep error classification and retries here so Actions logs name the real
 * failure (invalid key vs rate limit vs bad JSON) instead of a generic stack.
 */

const AUTH_HINT =
  'Fix: GitHub → Settings → Secrets and variables → Actions → ANTHROPIC_API_KEY. Paste a current Anthropic Console API key (starts with sk-ant-), no quotes and no trailing newline. Then Actions → Daily AI Digest → Run workflow.';

export function inspectApiKey(raw) {
  const original = raw == null ? '' : String(raw);
  const trimmed = original.trim();
  return {
    present: trimmed.length > 0,
    trimmed,
    length: trimmed.length,
    hadWhitespace: original !== trimmed,
    prefix: trimmed.slice(0, 7),
    looksLikeAnthropic: trimmed.startsWith('sk-ant-'),
  };
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nestedError(err) {
  const body = err?.error;
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    return body.error;
  }
  if (body && typeof body === 'object' && typeof body.type === 'string' && body.type !== 'error') {
    return body;
  }
  return body && typeof body === 'object' ? body : null;
}

function parseStatusFromMessage(message) {
  const m = String(message || '').match(/^(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

export function classifyAnthropicError(err) {
  const message = err?.error?.error?.message || err?.error?.message || err?.message || String(err);
  const nested = nestedError(err);
  const type = nested?.type || err?.error?.type || '';
  const status = err?.status ?? err?.statusCode ?? parseStatusFromMessage(message);
  const retryAfterHeader = err?.headers?.['retry-after'] ?? err?.headers?.get?.('retry-after');
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;

  if (status === 401 || type === 'authentication_error') {
    return {
      retryable: false,
      code: 'auth',
      summary: 'Anthropic rejected ANTHROPIC_API_KEY (401 authentication_error). The secret is present but invalid, expired, or has extra whitespace.',
      hint: AUTH_HINT,
    };
  }

  if (status === 403 || type === 'permission_error') {
    return {
      retryable: false,
      code: 'permission',
      summary: `Anthropic permission error (403): ${nested?.message || message}`,
      hint: 'The key is authenticated but not allowed to use this model or API. Check the Anthropic Console workspace and model access.',
    };
  }

  if (status === 404 || type === 'not_found_error') {
    return {
      retryable: false,
      code: 'model',
      summary: `Anthropic returned 404: ${nested?.message || message}`,
      hint: 'If this mentions the model name, set ANTHROPIC_MODEL to a current Messages API id (default is claude-haiku-4-5).',
    };
  }

  if (status === 400 || type === 'invalid_request_error') {
    const billing = /credit|billing|plan|quota/i.test(message);
    return {
      retryable: false,
      code: billing ? 'billing' : 'bad_request',
      summary: `Anthropic rejected the request (400): ${nested?.message || message}`,
      hint: billing
        ? 'Add credit or a valid billing method in the Anthropic Console, then re-run.'
        : 'Check model name, max_tokens, and request shape. This is not retried.',
    };
  }

  if (status === 429 || type === 'rate_limit_error') {
    return {
      retryable: true,
      code: 'rate_limit',
      summary: `Anthropic rate-limited the request (429): ${nested?.message || message}`,
      hint: 'Retrying with backoff. If this persists, the workspace is hitting token or request limits.',
      retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 4000,
    };
  }

  if (status === 529 || status === 500 || status === 502 || status === 503 || type === 'overloaded_error' || type === 'api_error') {
    return {
      retryable: true,
      code: 'unavailable',
      summary: `Anthropic is unavailable (${status || type}): ${nested?.message || message}`,
      hint: 'Transient API failure; retrying.',
      retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 3000,
    };
  }

  const code = err?.code || err?.cause?.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || err?.name === 'APIConnectionError') {
    return {
      retryable: true,
      code: 'network',
      summary: `Network error talking to Anthropic: ${message}`,
      hint: 'Transient connection failure; retrying.',
      retryAfterMs: 2000,
    };
  }

  return {
    retryable: false,
    code: 'unknown',
    summary: message,
    hint: 'See the stack in the Actions log for details.',
  };
}

export function classifyRemixError(err) {
  const message = err?.message || '';
  if (err instanceof SyntaxError || /No complete JSON/i.test(message)) {
    return {
      retryable: true,
      code: 'bad_json',
      summary: `Claude returned invalid JSON: ${message}`,
      hint: 'Retrying the model call. If this keeps happening, the response may be hitting max_tokens.',
      retryAfterMs: 1500,
    };
  }
  if (/no text block/i.test(message)) {
    return {
      retryable: true,
      code: 'empty_response',
      summary: 'Claude returned no text block',
      hint: 'Transient empty response; retrying.',
      retryAfterMs: 1500,
    };
  }
  return classifyAnthropicError(err);
}

export function formatDigestError(info, err, keyInfo) {
  const lines = [`remix-digest: FAILED — ${info.code}`, info.summary];
  if (keyInfo && (info.code === 'auth' || info.code === 'missing_key')) {
    lines.push(
      `key: present=${keyInfo.present} length=${keyInfo.length} prefix=${keyInfo.prefix || '(empty)'} had_whitespace=${keyInfo.hadWhitespace} looks_like_anthropic=${keyInfo.looksLikeAnthropic}`
    );
  }
  if (info.hint) lines.push(info.hint);
  if (err?.message && err.message !== info.summary) lines.push(`details: ${err.message}`);
  return `${lines.join('\n')}\n`;
}

export async function withRetries(fn, { maxAttempts = 3, classify = classifyAnthropicError, wait = sleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const info = classify(err);
      err.digestError = info;
      if (!info.retryable || attempt === maxAttempts) {
        throw err;
      }
      const delay = info.retryAfterMs || 1000 * (2 ** attempt);
      process.stderr.write(
        `remix-digest: ${info.code} on attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms — ${info.summary}\n`
      );
      await wait(delay);
    }
  }
  throw lastError;
}

export function summarizeHealth(health) {
  if (!health) return 'none';
  const labels = { x: 'x', podcasts: 'podcasts', rss: 'rss', hackernews: 'hn', github_trending: 'gh' };
  return Object.entries(health)
    .map(([k, v]) => `${labels[k] || k}=${v.ok}/${v.attempted}`)
    .join(' ');
}

export function compactSourceErrors(health) {
  if (!health) return [];
  const lines = [];
  for (const [key, value] of Object.entries(health)) {
    if (!value?.errors?.length) continue;
    const sample = value.errors[0];
    const extra = value.errors.length > 1 ? ` (+${value.errors.length - 1} more)` : '';
    lines.push(`${key}: ${sample}${extra}`);
  }
  return lines;
}
