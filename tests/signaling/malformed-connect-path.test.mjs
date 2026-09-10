import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function loadSignalingWorker() {
  const sourceUrl = new URL('../../services/signaling/src/index.js', import.meta.url);
  let source = await fs.readFile(sourceUrl, 'utf8');
  const sessionUrl = new URL('../../packages/core/session.js', import.meta.url).href;
  const resourceRoutesUrl = new URL('../../services/signaling/src/resource-routes.js', import.meta.url).href;

  source = source
    .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject {}')
    .replace("from '../../../packages/core/session.js';", `from '${sessionUrl}';`)
    .replace("from './resource-routes.js';", `from '${resourceRoutesUrl}';`);

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
