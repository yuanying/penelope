import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { backupReason } from './select-backup.mjs';

const url = 'http://metrics.example.com/metrics';
const now = Date.parse('2026-11-27T04:00:00Z');

async function volume(t, entry) {
  const dir = await mkdtemp(path.join(tmpdir(), 'penelope-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, entry));
  return dir;
}

const completed = (at) => async () => new Response(`penelope_sleep_last_completed_timestamp_seconds ${Date.parse(at) / 1000}\n`);

test('a sleep starts a backup only when newer than the last snapshot', async (t) => {
  const dir = await volume(t, '20261127T020000.021Z');
  assert.equal(await backupReason(dir, now, url, completed('2026-11-27T02:00:00.021Z')), undefined);
  assert.equal(await backupReason(dir, now, url, completed('2026-11-27T02:00:00.022Z')), 'new sleep');
});

test('an unavailable metric leaves only the 24-hour floor', async (t) => {
  const dir = await volume(t, '20261126T040000Z');
  const unavailable = async () => new Response('', { status: 503 });
  assert.equal(await backupReason(dir, now - 1, url, unavailable), undefined);
  assert.equal(await backupReason(dir, now, url, unavailable), 'daily floor');
});

test('a partial backup cannot suppress the first backup', async (t) => {
  const dir = await volume(t, '20261127T035500.000Z.partial');
  assert.equal(await backupReason(dir, now, undefined), 'daily floor');
});
