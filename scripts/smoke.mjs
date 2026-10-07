import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';

const dbPath = resolve('data/smoke.db');
rmSync(dbPath, { force: true });
const child = spawn(process.execPath, ['dist/bin/serve.js', '--port', '8123', '--db', dbPath], {
  stdio: 'ignore',
  detached: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

const base = 'http://127.0.0.1:8123';
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, json) =>
  (await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  })).json();

try {
  console.log('health:', await get('/api/health'));
  const sats = [
    { id: 'Z', azimuthDeg: 0, elevationDeg: 90 },
    { id: 'A', azimuthDeg: 0, elevationDeg: 0 },
    { id: 'B', azimuthDeg: 120, elevationDeg: 0 },
    { id: 'C', azimuthDeg: 240, elevationDeg: 0 },
  ];
  const created = await post('/api/constellations', { name: 'smoke', satellites: sats });
  console.log('created id:', created.constellation.id, 'version:', created.version);
  const r = await post(`/api/constellations/${created.constellation.id}/compute`, { cutoffDeg: 0 });
  console.log('compute status:', r.result.status, 'cached:', r.cached, 'GDOP:', r.result.metrics.GDOP.toFixed(6));
  const r2 = await post(`/api/constellations/${created.constellation.id}/compute`, { cutoffDeg: 0 });
  console.log('repeat cached:', r2.cached, 'same reportId:', r2.reportId === r.reportId);
  const loo = await post(`/api/constellations/${created.constellation.id}/leave-one-out`, {});
  console.log('leave-one-out:', loo.comparisons.map((c) => `${c.removedId}=${c.status}`).join(' '));
} finally {
  child.kill();
}
