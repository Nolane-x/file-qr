import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const signaling = fs.readFileSync(new URL('../../services/signaling/src/index.js', import.meta.url), 'utf8');
const resourceRoutes = fs.readFileSync(new URL('../../services/signaling/src/resource-routes.js', import.meta.url), 'utf8');
const rateImplementation = `${signaling}\n${resourceRoutes}`;
const wrangler = JSON.parse(fs.readFileSync(new URL('../../services/signaling/wrangler.jsonc', import.meta.url), 'utf8'));

function sourceSlice(source, startMarker, endMarker = null) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  if (endMarker) assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
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

test('session allocation entrypoint delegates fail-closed authority to the resource route', () => {
  const entry = sourceSlice(
    signaling,
    "if (url.pathname === '/v1/sessions' && request.method === 'POST')",
    "if (request.method === 'GET')",
  );
  assert.match(entry, /cf-connecting-ip/i);
  assert.match(entry, /handleSessionAllocation/);
  assert.match(entry, /rateLimitBinding:\s*env\.SESSION_ALLOCATION_RATE_LIMIT/);
  assert.match(entry, /createReceiveCodeImpl/);
  assert.match(entry, /randomTokenImpl/);
  assert.match(entry, /initRoomImpl/);
});

test('session allocation hashes and rate-limits before code token or room allocation side effects', () => {
  const implementation = sourceSlice(
    resourceRoutes,
    'export async function handleSessionAllocation',
    'export async function handleTurnCredentials',
  );
  const hashed = implementation.indexOf("hashedRateLimitKey('session', actor)");
  const limited = implementation.indexOf('enforceRateLimit(rateLimitBinding, sessionRateKey');
  const code = implementation.indexOf('createReceiveCodeImpl()');
  const token = implementation.indexOf('randomTokenImpl()');
  const room = implementation.indexOf('initRoomImpl(code');

  assert.ok(hashed >= 0, 'session actor must be converted to an opaque rate-limit key');
  assert.ok(limited > hashed, 'session rate limiter must consume only the hashed actor key');
  assert.ok(code > limited, 'receive-code allocation must happen after rate-limit admission');
  assert.ok(token > limited, 'sender-token allocation must happen after rate-limit admission');
  assert.ok(room > limited, 'Durable Object initialization must happen after rate-limit admission');
  assert.match(resourceRoutes, /crypto\.subtle\.digest\('SHA-256'/i);
});

test('TURN entrypoint preserves live-lease authorization and provider dependency boundaries', () => {
  const entry = sourceSlice(
    signaling,
    "if (url.pathname === '/v1/turn-credentials' && request.method === 'POST')",
    "if (url.pathname === '/v1/sessions' && request.method === 'POST')",
  );
  assert.match(entry, /turnConfiguredImpl/);
  assert.match(entry, /turn-authorize/);
  assert.match(entry, /compactCodeImpl/);
  assert.match(entry, /rateLimitBinding:\s*env\.TURN_CREDENTIAL_RATE_LIMIT/);
  assert.match(entry, /generateTurnCredentialsImpl/);
});

test('TURN credential minting authorizes lease then hashes and rate-limits before provider call', () => {
  const implementation = sourceSlice(resourceRoutes, 'export async function handleTurnCredentials');
  const configured = implementation.indexOf('turnConfiguredImpl()');
  const authorize = implementation.indexOf('authorizeTurnImpl(code)');
  const hashed = implementation.indexOf("hashedRateLimitKey('turn', compactCodeImpl(code))");
  const limited = implementation.indexOf('enforceRateLimit(rateLimitBinding, turnRateKey');
  const provider = implementation.indexOf('generateTurnCredentialsImpl({ leaseExpiresAt })');

  assert.ok(configured >= 0, 'TURN configuration must be checked first');
  assert.ok(authorize > configured, 'live lease authorization must follow configuration');
  assert.ok(hashed > authorize, 'TURN capability must be hashed only after live-lease authorization');
  assert.ok(limited > hashed, 'TURN rate limiter must receive the opaque hashed capability key');
  assert.ok(provider > limited, 'provider credential generation must happen only after rate-limit admission');
  assert.match(resourceRoutes, /crypto\.subtle\.digest\('SHA-256'/i);
});

test('rate-limit denial is explicit and limiter unavailability fails closed', () => {
  assert.match(rateImplementation, /rate-limited/);
  assert.match(rateImplementation, /status:\s*429/);
  assert.match(rateImplementation, /retry-after/);
  assert.match(rateImplementation, /rate-limit-unavailable/);
  assert.match(rateImplementation, /status:\s*503/);
});
