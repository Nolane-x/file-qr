export function formatEta(remainingMs) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(remainingMs / 1000));
  if (totalSeconds < 60) return `~${totalSeconds}s left`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `~${minutes}m ${String(seconds).padStart(2, '0')}s left`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `~${hours}h ${String(minutes).padStart(2, '0')}m left`;
}

export function estimateEta(done, total, elapsedMs) {
  if (!Number.isFinite(done) || !Number.isFinite(total) || !Number.isFinite(elapsedMs)) return null;
  if (done <= 0 || total <= done || elapsedMs < 750) return null;
  const bytesPerMs = done / elapsedMs;
  if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) return null;
  return formatEta((total - done) / bytesPerMs);
}
