import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const signalingOrigin = String(
  process.env.FILE_QR_SIGNALING_ORIGIN || 'https://file-qr-signaling.nolane-file.workers.dev',
).replace(/\/$/, '');
const evidencePath = process.env.FILE_QR_TURN_EVIDENCE_PATH || 'turn-relay-evidence.json';
const timeoutMs = Number(process.env.FILE_QR_TURN_TIMEOUT_MS || 45_000);

if (!/^https:\/\//i.test(signalingOrigin)) {
  throw new Error('Production TURN evidence requires an HTTPS signaling origin');
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async ({ origin, timeout }) => {
    const fail = (message) => { throw new Error(message); };
    const withTimeout = (promise, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeout)),
    ]);

    const sessionResponse = await fetch(`${origin}/v1/sessions`, { method: 'POST' });
    if (!sessionResponse.ok) fail(`session allocation failed: HTTP ${sessionResponse.status}`);
    const session = await sessionResponse.json();
    if (!session?.code || !Number.isFinite(session?.expiresAt)) fail('session allocation returned invalid data');

    const turnResponse = await fetch(`${origin}/v1/turn-credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: session.code }),
    });
    if (!turnResponse.ok) fail(`TURN credentials unavailable: HTTP ${turnResponse.status}`);
    const turn = await turnResponse.json();
    if (!Array.isArray(turn?.iceServers) || turn.iceServers.length === 0) fail('TURN provider returned no ICE servers');
    if (!Number.isFinite(turn?.expiresAt) || turn.expiresAt <= Date.now()) fail('TURN credentials are expired or missing expiry');

    const validTurnServers = turn.iceServers.filter((server) => {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      return urls.some((url) => typeof url === 'string' && /^turns?:/i.test(url))
        && typeof server?.username === 'string'
        && typeof server?.credential === 'string';
    });
    if (validTurnServers.length === 0) fail('TURN provider returned no valid authenticated relay server');

    const config = { iceServers: validTurnServers, iceTransportPolicy: 'relay' };
    const left = new RTCPeerConnection(config);
    const right = new RTCPeerConnection(config);
    const leftQueue = [];
    const rightQueue = [];

    async function forward(candidate, target, queue) {
      if (!candidate) return;
      if (!target.remoteDescription) {
        queue.push(candidate);
        return;
      }
      await target.addIceCandidate(candidate);
    }

    async function flush(target, queue) {
      while (queue.length) await target.addIceCandidate(queue.shift());
    }

    left.addEventListener('icecandidate', ({ candidate }) => {
      forward(candidate, right, rightQueue).catch(() => {});
    });
    right.addEventListener('icecandidate', ({ candidate }) => {
      forward(candidate, left, leftQueue).catch(() => {});
    });

    const received = new Promise((resolve, reject) => {
      right.addEventListener('datachannel', ({ channel }) => {
        channel.addEventListener('message', ({ data }) => resolve(String(data)), { once: true });
        channel.addEventListener('error', () => reject(new Error('receiver data channel failed')), { once: true });
      }, { once: true });
    });

    const channel = left.createDataChannel('file-qr-turn-probe');
    const opened = new Promise((resolve, reject) => {
      if (channel.readyState === 'open') return resolve();
      channel.addEventListener('open', resolve, { once: true });
      channel.addEventListener('error', () => reject(new Error('sender data channel failed')), { once: true });
    });

    const offer = await left.createOffer();
    await left.setLocalDescription(offer);
    await right.setRemoteDescription(left.localDescription);
    await flush(right, rightQueue);
    const answer = await right.createAnswer();
    await right.setLocalDescription(answer);
    await left.setRemoteDescription(right.localDescription);
    await flush(left, leftQueue);

    await withTimeout(opened, 'relay data channel');
    const payload = `file-qr-relay-${crypto.randomUUID()}`;
    channel.send(payload);
    const echoed = await withTimeout(received, 'relay payload');
    if (echoed !== payload) fail('relay payload mismatch');

    async function selectedCandidateType(peer) {
      const report = await peer.getStats();
      const values = [...report.values()];
      const transport = values.find((entry) => entry.type === 'transport' && entry.selectedCandidatePairId);
      let pair = transport?.selectedCandidatePairId ? report.get(transport.selectedCandidatePairId) : null;
      if (!pair) pair = values.find((entry) => entry.type === 'candidate-pair' && (entry.selected === true || (entry.nominated === true && entry.state === 'succeeded')));
      if (!pair) return 'unknown';
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
      if (local?.candidateType || remote?.candidateType) return 'direct';
      return 'unknown';
    }

    const [leftType, rightType] = await Promise.all([
      selectedCandidateType(left),
      selectedCandidateType(right),
    ]);
    left.close();
    right.close();

    if (leftType !== 'relay' || rightType !== 'relay') {
      fail(`relay-only policy connected without relay stats: left=${leftType} right=${rightType}`);
    }

    return {
      selectedCandidateType: { left: leftType, right: rightType },
      turnServerCount: validTurnServers.length,
      credentialExpiresAt: turn.expiresAt,
      sessionExpiresAt: session.expiresAt,
      payloadVerified: true,
    };
  }, { origin: signalingOrigin, timeout: timeoutMs });

  const evidence = {
    schemaVersion: 1,
    test: 'production-turn-relay',
    signalingOrigin,
    observedAt: new Date().toISOString(),
    gitSha: process.env.GITHUB_SHA || null,
    ...result,
  };

  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`TURN relay evidence PASS: ${result.selectedCandidateType.left}/${result.selectedCandidateType.right}`);
} finally {
  await browser.close();
}
