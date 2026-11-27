import { readdir, writeFile } from 'node:fs/promises';

const snapshotName = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
const completionSample = /^penelope_sleep_last_completed_timestamp_seconds (\d+(?:\.\d+)?)$/m;

export async function backupReason(dir, now, metricsUrl, fetchMetrics = fetch) {
  let last = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = snapshotName.exec(entry.name);
    if (!match) continue;
    const [, year, month, day, hour, minute, second, fraction = ''] = match;
    const at = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}Z`);
    if (at > last) last = at;
  }
  if (last === 0 || now - last >= 86_400_000) return 'daily floor';
  if (metricsUrl && await sleepCompletedMs(metricsUrl, fetchMetrics) > last) return 'new sleep';
}

async function sleepCompletedMs(url, fetchMetrics) {
  try {
    const response = await fetchMetrics(url, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
    if (!response.ok) throw new Error('metrics response failed');
    const sample = completionSample.exec(await response.text())?.[1];
    const at = Math.round(Number(sample) * 1_000);
    if (!Number.isSafeInteger(at)) throw new Error('invalid sleep completion timestamp');
    return at;
  } catch {
    console.warn('backup: could not read sleep completion; using the daily floor');
    return 0;
  }
}

if (import.meta.main) {
  const reason = process.env.FORCE_BACKUP === '1'
    ? 'forced'
    : await backupReason('/backup', Date.now(), process.env.BACKUP_METRICS_URL);
  if (reason === undefined) {
    console.log('backup: no new sleep and the last backup is less than 24 hours old');
  } else {
    const stamp = new Date().toISOString().replace(/[-:]/g, '');
    await writeFile('/staging/backup-stamp', stamp, { mode: 0o644 });
    console.log(`backup: starting (${reason})`);
  }
}
