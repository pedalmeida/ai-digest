import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectApiKey,
  classifyAnthropicError,
  classifyRemixError,
  formatDigestError,
  withRetries,
  summarizeHealth,
  compactSourceErrors,
} from './claude-request.js';

test('inspectApiKey trims GitHub-secret whitespace and reports prefix', () => {
  const info = inspectApiKey('  sk-ant-api03-example\n');
  assert.equal(info.present, true);
  assert.equal(info.hadWhitespace, true);
  assert.equal(info.looksLikeAnthropic, true);
  assert.equal(info.prefix, 'sk-ant-');
  assert.equal(info.trimmed, 'sk-ant-api03-example');
});

test('inspectApiKey treats empty and whitespace-only as missing', () => {
  assert.equal(inspectApiKey('').present, false);
  assert.equal(inspectApiKey(' \n\t ').present, false);
});

test('classifyAnthropicError treats 401 as a non-retryable auth failure', () => {
  const err = {
    status: 401,
    message: '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}',
    error: {
      type: 'error',
      error: { type: 'authentication_error', message: 'API key is invalid.' },
      request_id: null,
    },
  };
  const info = classifyAnthropicError(err);
  assert.equal(info.retryable, false);
  assert.equal(info.code, 'auth');
  assert.match(info.hint, /ANTHROPIC_API_KEY/);
});

test('classifyAnthropicError still flags auth when the SDK only puts 401 in the message', () => {
  const info = classifyAnthropicError(
    new Error('401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}')
  );
  assert.equal(info.code, 'auth');
  assert.equal(info.retryable, false);
});

test('classifyAnthropicError retries 429 and 529', () => {
  assert.equal(classifyAnthropicError({ status: 429, error: { type: 'rate_limit_error' } }).retryable, true);
  assert.equal(classifyAnthropicError({ status: 529, error: { type: 'overloaded_error' } }).retryable, true);
  assert.equal(classifyAnthropicError({ status: 500 }).code, 'unavailable');
});

test('classifyAnthropicError names a missing model as non-retryable', () => {
  const info = classifyAnthropicError({
    status: 404,
    error: { type: 'not_found_error', message: 'model: claude-haiku-4-5' },
  });
  assert.equal(info.retryable, false);
  assert.equal(info.code, 'model');
});

test('classifyRemixError retries invalid JSON from the model', () => {
  const info = classifyRemixError(new SyntaxError('No complete JSON object found in Claude response'));
  assert.equal(info.retryable, true);
  assert.equal(info.code, 'bad_json');
});

test('formatDigestError includes key inspection on auth failures without leaking the secret', () => {
  const info = classifyAnthropicError({ status: 401, error: { error: { type: 'authentication_error', message: 'API key is invalid.' } } });
  const text = formatDigestError(info, { message: '401 API key is invalid.' }, inspectApiKey('sk-ant-secret-should-not-appear'));
  assert.match(text, /FAILED — auth/);
  assert.match(text, /prefix=sk-ant-/);
  assert.doesNotMatch(text, /secret-should-not-appear/);
});

test('withRetries retries retryable errors then succeeds', async () => {
  let calls = 0;
  const result = await withRetries(async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('overloaded');
      err.status = 529;
      throw err;
    }
    return 'ok';
  }, { maxAttempts: 3, wait: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetries does not retry 401', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetries(async () => {
      calls += 1;
      const err = new Error('API key is invalid.');
      err.status = 401;
      err.error = { error: { type: 'authentication_error', message: 'API key is invalid.' } };
      throw err;
    }, { maxAttempts: 3 }),
    /API key is invalid/
  );
  assert.equal(calls, 1);
});

test('summarizeHealth and compactSourceErrors keep Actions logs short', () => {
  const health = {
    x: { attempted: 15, ok: 0, errors: ['@karpathy: HTTP 402: credits depleted', '@sama: HTTP 402'] },
    rss: { attempted: 22, ok: 22, errors: [] },
  };
  assert.equal(summarizeHealth(health), 'x=0/15 rss=22/22');
  assert.deepEqual(compactSourceErrors(health), ['x: @karpathy: HTTP 402: credits depleted (+1 more)']);
});
