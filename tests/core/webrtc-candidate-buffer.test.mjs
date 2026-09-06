import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteCandidateBuffer } from '../../apps/web/src/webrtc.js';

test('remote ICE candidates wait until a remote description exists', async () => {
  const added = [];
  const peer = {
    remoteDescription: null,
    async addIceCandidate(candidate) { added.push(candidate); }
  };
  const buffer = createRemoteCandidateBuffer(peer);
  await buffer.add({ candidate: 'one' });
  await buffer.add({ candidate: 'two' });
  assert.deepEqual(added, []);
  peer.remoteDescription = { type: 'offer' };
  await buffer.flush();
  assert.deepEqual(added.map(x => x.candidate), ['one', 'two']);
});
