import { spawn } from 'node:child_process';

const signalingOrigin = String(
  process.env.FILE_QR_SIGNALING_ORIGIN || 'https://file-qr-signaling.nolane-file.workers.dev',
).replace(/\/$/, '');
const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const workerApiToken = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
const callsApiToken = String(process.env.CLOUDFLARE_CALLS_API_TOKEN || '').trim();
const managedKeyName = 'file-qr-signaling-production';

if (!/^https:\/\//i.test(signalingOrigin)) {
  throw new Error('Production TURN bootstrap requires an HTTPS signaling origin');
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function allocateSession() {
  const response = await fetch(`${signalingOrigin}/v1/sessions`, { method: 'POST' });
  const body = await readJson(response);
  if (!response.ok || typeof body?.code !== 'string') {
    throw new Error(`Unable to allocate production signaling session: HTTP ${response.status}`);
  }
  return body.code;
}

async function requestTurn(code) {
  const response = await fetch(`${signalingOrigin}/v1/turn-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { response, body: await readJson(response) };
}

async function createManagedTurnKey() {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/calls/turn_keys`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callsApiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: managedKeyName }),
    },
  );
  const body = await readJson(response);
  if (!response.ok || body?.success !== true) {
    const messages = Array.isArray(body?.errors)
      ? body.errors.map((entry) => String(entry?.message || '')).filter(Boolean).join('; ')
      : '';
    throw new Error(
      `Cloudflare TURN key creation failed: HTTP ${response.status}${messages ? ` (${messages})` : ''}. `
      + 'CLOUDFLARE_CALLS_API_TOKEN must include Calls Write permission.',
    );
  }

  const uid = String(body?.result?.uid || '');
  const key = String(body?.result?.key || '');
  if (!/^[A-Za-z0-9_-]{32}$/.test(uid) || key.length !== 64) {
    throw new Error('Cloudflare TURN key creation returned invalid key material');
  }
  return { uid, key };
}

async function putWorkerSecrets(secrets) {
  await new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const childEnv = {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: workerApiToken,
    };
    delete childEnv.CLOUDFLARE_CALLS_API_TOKEN;

    const child = spawn(
      command,
      ['wrangler', 'secret', 'bulk', '--config', 'services/signaling/wrangler.jsonc'],
      {
        env: childEnv,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret bulk failed (${signal || `exit ${code}`})`));
    });
    child.stdin.end(`${JSON.stringify(secrets)}\n`);
  });
}

let code = await allocateSession();
let turn = await requestTurn(code);
if (turn.response.ok) {
  console.log('Production TURN is already configured; bootstrap is a no-op.');
  process.exit(0);
}

if (turn.response.status !== 404 || turn.body?.error !== 'turn-not-configured') {
  throw new Error(`Production TURN preflight failed unexpectedly: HTTP ${turn.response.status}`);
}

if (!accountId || !workerApiToken || !callsApiToken) {
  throw new Error(
    'Production TURN is unconfigured. Bootstrap requires CLOUDFLARE_ACCOUNT_ID, '
    + 'CLOUDFLARE_API_TOKEN for Worker secret writes, and CLOUDFLARE_CALLS_API_TOKEN with Calls Write.',
  );
}

const { uid, key } = await createManagedTurnKey();
process.stdout.write(`::add-mask::${uid}\n`);
process.stdout.write(`::add-mask::${key}\n`);

await putWorkerSecrets({
  TURN_KEY_ID: uid,
  TURN_KEY_API_TOKEN: key,
});

for (let attempt = 1; attempt <= 15; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  code = await allocateSession();
  turn = await requestTurn(code);
  if (turn.response.ok) {
    console.log('Production TURN bootstrap verified: short-lived credentials are now available.');
    process.exit(0);
  }
  if (turn.response.status !== 404 || turn.body?.error !== 'turn-not-configured') {
    throw new Error(`Production TURN verification failed: HTTP ${turn.response.status}`);
  }
}

throw new Error('Production TURN secrets were written but the credentials endpoint remained unconfigured');
