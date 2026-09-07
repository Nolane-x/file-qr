import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const securityUrl = new URL('../../SECURITY.md', import.meta.url);
const protocolUrl = new URL('../../docs/architecture/PROTOCOL.md', import.meta.url);

test('security threat model matches the reusable v0.4 session contract and TURN boundary', () => {
  const security = fs.readFileSync(securityUrl, 'utf8');

  assert.match(security, /v0\.4 threat model/i);
  assert.match(security, /600 seconds/);
  assert.match(security, /reusable/i);
  assert.match(security, /attemptId/);
  assert.match(security, /one receiver/i);
  assert.match(security, /sequential/i);
  assert.match(security, /short-lived/i);
  assert.match(security, /long-lived TURN/i);
  assert.match(security, /not.*production-ready|do not claim.*production-ready/is);
  assert.doesNotMatch(security, /marks the rendezvous consumed when the direct transfer opens/i);
  assert.doesNotMatch(security, /TURN relay is \*\*not enabled\*\* in v0\.2/i);
});

test('protocol documentation describes protocol v2 resume and per-attempt signaling', () => {
  const protocol = fs.readFileSync(protocolUrl, 'utf8');

  assert.match(protocol, /Protocol v0\.4/i);
  assert.match(protocol, /protocol v2/i);
  assert.match(protocol, /attemptId/);
  assert.match(protocol, /file-offer/);
  assert.match(protocol, /resume-request/);
  assert.match(protocol, /complete-ack/);
  assert.match(protocol, /absolute byte offset/i);
  assert.match(protocol, /600 seconds/);
  assert.match(protocol, /sequential/i);
  assert.match(protocol, /one receiver/i);
  assert.match(protocol, /TURN/i);
  assert.match(protocol, /short-lived/i);
  assert.doesNotMatch(protocol, /sends a JSON `meta` control message/i);
});
