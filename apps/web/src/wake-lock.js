export function createWakeLockController({
  wakeLockApi = globalThis.navigator?.wakeLock ?? null,
  documentRef = globalThis.document ?? null,
} = {}) {
  let sentinel = null;
  let active = false;
  let destroyed = false;

  async function release() {
    const current = sentinel;
    sentinel = null;
    if (!current?.release) return;
    try { await current.release(); } catch { /* best-effort only */ }
  }

  async function acquire() {
    if (destroyed || !active || sentinel || !wakeLockApi?.request) return false;
    if (documentRef?.visibilityState === 'hidden') return false;
    try {
      sentinel = await wakeLockApi.request('screen');
      sentinel?.addEventListener?.('release', () => {
        sentinel = null;
        if (active && !destroyed && documentRef?.visibilityState !== 'hidden') {
          queueMicrotask(() => { acquire().catch(() => {}); });
        }
      });
      return true;
    } catch {
      sentinel = null;
      return false;
    }
  }

  async function sync(nextActive) {
    active = Boolean(nextActive);
    if (!active) {
      await release();
      return false;
    }
    return acquire();
  }

  function onVisibilityChange() {
    if (documentRef?.visibilityState === 'hidden') {
      release().catch(() => {});
      return;
    }
    if (active) acquire().catch(() => {});
  }

  documentRef?.addEventListener?.('visibilitychange', onVisibilityChange);

  function destroy() {
    destroyed = true;
    active = false;
    documentRef?.removeEventListener?.('visibilitychange', onVisibilityChange);
    release().catch(() => {});
  }

  return { sync, release, destroy };
}
