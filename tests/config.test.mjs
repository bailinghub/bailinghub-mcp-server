import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, normalizeBaseUrl } from '../dist/config.js';

test('loads one fixed route and rejects missing configuration', () => {
  assert.deepEqual(
    loadConfig({
      BAILINGHUB_BASE_URL: 'https://hub.example.com/',
      BAILINGHUB_CLIENT_TOKEN: 'client-token',
      BAILINGHUB_ROUTE: 'order_assistant',
    }),
    {
      baseUrl: 'https://hub.example.com',
      clientToken: 'client-token',
      route: 'order_assistant',
    },
  );
  assert.throws(() => loadConfig({}), /BAILINGHUB_ROUTE is required/);
  assert.throws(
    () =>
      loadConfig({
        BAILINGHUB_BASE_URL: 'https://hub.example.com',
        BAILINGHUB_CLIENT_TOKEN: 'client-token',
        BAILINGHUB_ROUTE: '../admin',
      }),
    /BAILINGHUB_ROUTE must match/,
  );
});

test('requires HTTPS for remote origins unless the operator explicitly opts in', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(
    normalizeBaseUrl('http://hub.internal:3000/', true),
    'http://hub.internal:3000',
  );
  assert.throws(() => normalizeBaseUrl('http://hub.example.com'), /Use HTTPS/);
  assert.throws(
    () => normalizeBaseUrl('https://admin:secret@hub.example.com'),
    /embedded credentials/,
  );
  assert.throws(
    () => normalizeBaseUrl('https://hub.example.com?token=secret'),
    /query string or fragment/,
  );
});
