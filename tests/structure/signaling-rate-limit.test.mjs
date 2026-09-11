import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const signaling = fs.readFileSync(new URL('../../services/signaling/src/index.js', import.meta.url), 'utf8');
const resourceRoutes = fs.readFileSync(new URL('../../services/signaling/src/resource-routes.js', import.meta.url), 'utf8');
const rateImplementation = `${signaling}\n${resourceRoutes}`;
const wrangler = JSON.parse(fs.readFileSync(new URL('../../services/signaling/wrangler.jsonc', import.meta.url), 'utf8'));

function routeSlice(startMarker, endMarker) {
  const start = signaling.indexOf(startMarker);
  const end = signaling.indexOf(endMarker, start + 1);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing route end marker: ${endMarker}`);
  return signaling.slice(start, end);
}

test('signaling config declares independent native Cloudflare rate-limit bindings', () => {
  assert.ok(Array.isArray(wrangler.ratelimits), 'wrangler must declare ratelimits');
  const byName = new Map(wrangler.ratelimits.map((entry) => [entry.name, entry]));
  const sessions = byName.get('SESSION_ALLOCATION_RATE_LIMIT');
  const turn = byName.get('TURN_CREDENTIAL_RATE_LIMIT');

  assert.ok(sessions, 'missing SESSION_ALLOCATION_RATE_LIMIT');
  assert.ok(turn, 'missing TURN_CREDENTIAL_RATE_LIMIT');
  assert.notEqual(sessions.namespace_id, turn.namespace_id, 'rate-limit namespaces must not share counters');
  assert.deepEqual(sessions.simple, { limit: 120, period: 60 });
  assert.deepEqual(turn.simple, { limit: 30, period: 60 });
});

test('session allocation is rate-limited before any room initialization', () => {
  const route = routeSlice("if (url.pathname === '/v1/sessions' && request.method === 'POST')", 'const match = url.pathname.match');
  const limiter = route.indexOf('SESSION_ALLOCATION_RATE_LIMIT');
  const allocation = route.indexOf('createReceiveCode()');
  const roomInit = route.indexOf("https://room.internal/init");

  assert.ok(limiter >= 0, 'session route must invoke SESSION_ALLOCATION_RATE_LIMIT');
  assert.ok(allocation > limiter, 'session limiter must run before receive-code allocation');
  assert.ok(roomInit > limiter, 'session limiter must run before Durable Object initialization');
  assert.match(route, /cf-connecting-ip/i);
  assert.match(route, /SHA-256/i);
});

test('TURN credential minting rate-limits only after live-lease authorization and before provider call', () => {
  const route = routeSlice("if (url.pathname === '/v1/turn-credentials' && request.method === 'POST')", "if (url.pathname === '/v1/sessions' && request.method === 'POST')");
  const configured = route.indexOf('turnConfigured(env)');
  const authorize = route.indexOf('turn-authorize');
  const limiter = route.indexOf('TURN_CREDENTIAL_RATE_LIMIT');
  const provider = route.indexOf('generateTurnCredentials(env, options)');

  assert.ok(configured >= 0 && authorize > configured, 'TURN configuration and lease authorization must remain first');
  assert.ok(limiter > authorize, 'TURN limiter must run only after live-lease authorization');
  assert.ok(provider > limiter, 'TURN limiter must deny before provider credential generation');
  assert.match(route, /compactReceiveCode\(code\)/);
  assert.match(route, /SHA-256/i);
});

test('rate-limit denial is explicit and limiter unavailability fails closed', () => {
  assert.match(rateImplementation, /rate-limited/);
  assert.match(rateImplementation, /status:\s*429/);
  assert.match(rateImplementation, /retry-after/);
  assert.match(rateImplementation, /rate-limit-unavailable/);
  assert.match(rateImplementation, /status:\s*503/);
});
