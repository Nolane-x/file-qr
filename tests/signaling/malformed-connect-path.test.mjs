import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function loadSignalingWorker() {
  const sourceUrl = new URL('../../services/signaling/src/index.js', import.meta.url);
  let source = await fs.readFile(sourceUrl, 'utf8');
  const sessionUrl = new URL('../../packages/core/session.js', import.meta.url).href;
  const resourceRoutesUrl = new URL('../../services/signaling/src/resource-routes.js', import.meta.url).href;
  const signalingMessageUrl = new URL('../../services/signaling/src/signaling-message.js', import.meta.url).href;
  const relayAuthorityUrl = new URL('../../services/signaling/src/relay-authority.js', import.meta.url).href;
  const relayForwarderUrl = new URL('../../services/signaling/src/relay-forwarder.js', import.meta.url).href;

  source = source
    .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject {}')
    .replace("from '../../../packages/core/session.js';", `from '${sessionUrl}';`)
    .replace("from './resource-routes.js';", `from '${resourceRoutesUrl}';`)
    .replace("from './signaling-message.js';", `from '${signalingMessageUrl}';`)
    .replace("from './relay-authority.js';", `from '${relayAuthorityUrl}';`)
    .replace("from './relay-forwarder.js';", `from '${relayForwarderUrl}';`);

  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('malformed percent-encoding in connect path fails closed', async () => {
  const { default: worker } = await loadSignalingWorker();
  const response = await worker.fetch(
    new Request('https://signaling.test/v1/sessions/%/connect?role=receiver'),
    {},
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'session-not-found' });
});

test('malformed percent-encoding in relay path fails closed before Durable Object lookup', async () => {
  const { default: worker } = await loadSignalingWorker();
  const response = await worker.fetch(
    new Request('https://signaling.test/v1/sessions/%/relay?role=receiver'),
    {},
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'session-not-found' });
});
