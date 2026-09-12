import { isReceiveCode, normalizeReceiveCode } from '../../../packages/core/session.js';
import { parseReceivePayloadDetails } from './receive-payload.js';
import {
  REPO_RELEASE,
  cleanupLease,
  copyText,
  current,
  platformSupported,
  resetProgress,
  scanner,
  setState,
  stopScanner,
  ui,
  wakeLock,
} from './runtime-core.js';
import { receiveFile, sendFile } from './runtime-session.js';

async function onScannedPayload(payload) {
  const details = parseReceivePayloadDetails(payload);
  if (!details) {
    ui.status.textContent = 'Not a File QR receive code.';
    if (ui.scannerPanel && !ui.scannerPanel.hidden && scanner) {
      try { await scanner.start(onScannedPayload); }
      catch (error) {
        stopScanner();
        ui.status.textContent = `Camera unavailable: ${error?.message || error}`;
      }
    }
    return;
  }
  if (ui.codeInput) ui.codeInput.value = details.code;
  stopScanner();
  await receiveFile(details.code, details.relaySecret);
}

async function startScanner() {
  if (!scanner || !navigator.mediaDevices?.getUserMedia) {
    ui.status.textContent = 'Camera scanning is unavailable in this browser. Enter the code instead.';
    return;
  }
  stopScanner();
  ui.scannerPanel.hidden = false;
  ui.scanQr.disabled = true;
  ui.status.textContent = 'Opening camera…';
  try {
    await scanner.start(onScannedPayload);
    ui.status.textContent = 'Camera ready. Point it at a File QR receive code.';
  } catch (error) {
    stopScanner();
    ui.status.textContent = `Camera unavailable: ${error?.message || error}`;
  }
}

async function pasteReceivePayload() {
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable.');
    const payload = await navigator.clipboard.readText();
    const details = parseReceivePayloadDetails(payload);
    if (!details) {
      ui.status.textContent = 'Clipboard does not contain a File QR receive code.';
      ui.codeInput?.focus();
      return;
    }
    ui.codeInput.value = details.code;
    await receiveFile(details.code, details.relaySecret);
  } catch (error) {
    ui.status.textContent = error?.message || 'Paste was blocked by the browser.';
    ui.codeInput?.focus();
  }
}

async function reset() {
  await cleanupLease({ discardPartial: true });
  resetProgress();
  ui.qr.innerHTML = '';
  history.replaceState({}, '', location.pathname);
  setState('idle');
}

function bindUiEvents() {
  ui.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      ui.fileInput.click();
    }
  });
  ui.fileInput.addEventListener('change', () => {
    const [file] = ui.fileInput.files;
    if (file) sendFile(file).catch(() => {});
  });
  for (const eventName of ['dragenter', 'dragover']) {
    window.addEventListener(eventName, (event) => {
      event.preventDefault();
      document.body.dataset.dragging = 'true';
      if (current().state === 'idle') setState('drag-over');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    window.addEventListener(eventName, (event) => {
      event.preventDefault();
      document.body.dataset.dragging = 'false';
      if (eventName === 'dragleave' && current().state === 'drag-over') setState('idle');
    });
  }
  window.addEventListener('drop', (event) => {
    const [file] = event.dataTransfer?.files || [];
    if (file) sendFile(file).catch(() => {});
  });
  ui.receiveForm.addEventListener('submit', (event) => {
    event.preventDefault();
    receiveFile(ui.codeInput.value, null).catch(() => {});
  });
  ui.codeInput.addEventListener('input', () => {
    if (isReceiveCode(ui.codeInput.value)) ui.codeInput.value = normalizeReceiveCode(ui.codeInput.value);
  });
  ui.pasteCode?.addEventListener('click', () => { pasteReceivePayload().catch(() => {}); });
  ui.scanQr?.addEventListener('click', () => { startScanner().catch(() => {}); });
  ui.scannerCancel?.addEventListener('click', () => {
    stopScanner();
    ui.status.textContent = 'Camera scan cancelled. Enter a code or scan again.';
  });
  ui.copyCode.addEventListener('click', () => copyText(current().code, 'Receive code copied.'));
  ui.copyLink.addEventListener('click', () => copyText(current().receiveUrl, 'Receive link copied.'));
  ui.cancel.addEventListener('click', () => {
    cleanupLease({ keepView: true, discardPartial: true })
      .then(() => setState('cancelled'))
      .catch(() => {});
  });
  ui.again.addEventListener('click', () => { reset().catch(() => {}); });
  window.addEventListener('pagehide', () => {
    cleanupLease({ discardPartial: false }).catch(() => {});
    wakeLock.destroy();
  });
}

function initialReceivePayload() {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
  const fragmentAuthority = fragment.has('receive') || fragment.has('relay');
  const hasPayload = query.has('receive') || query.has('relay') || fragmentAuthority;
  const details = hasPayload ? parseReceivePayloadDetails(location.href) : null;

  if (fragmentAuthority || query.has('relay')) {
    const scrubbedQuery = new URLSearchParams(location.search);
    scrubbedQuery.delete('relay');
    const serialized = scrubbedQuery.toString();
    history.replaceState({}, '', `${location.pathname}${serialized ? `?${serialized}` : ''}`);
  }
  return { hasPayload, details };
}

export function bootstrapFileQrUi() {
  bindUiEvents();
  if (ui.scanQr && (!scanner || !navigator.mediaDevices?.getUserMedia)) ui.scanQr.hidden = true;

  const initial = initialReceivePayload();
  if (!platformSupported()) {
    setState('unsupported', `Use Windows or Android. Native downloads are available at ${REPO_RELEASE}.`);
    return;
  }
  if (initial.hasPayload) {
    if (initial.details) receiveFile(initial.details.code, initial.details.relaySecret).catch(() => {});
    else {
      setState('idle');
      ui.status.textContent = 'That receive link is not valid.';
    }
    return;
  }
  setState('idle');
}
