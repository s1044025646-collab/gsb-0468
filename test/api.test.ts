import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { startServer } from '../src/server.js';

const tmpDir = resolve(__dirname, '../data/.tmp-api');
const dbPath = resolve(tmpDir, 'api.db');
let server: Server;
let store: { close: () => void };
let base: string;

const sats = [
  { id: 'Z', azimuthDeg: 0, elevationDeg: 90 },
  { id: 'A', azimuthDeg: 0, elevationDeg: 0 },
  { id: 'B', azimuthDeg: 120, elevationDeg: 0 },
  { id: 'C', azimuthDeg: 240, elevationDeg: 0 },
];

beforeAll(async () => {
  rmSync(tmpDir, { recursive: true, force: true });
  const started = await startServer(dbPath);
  server = started.server;
  store = started.store;
  base = `http://127.0.0.1:${started.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit & { json?: unknown }) {
  const res = await fetch(base + path, {
    method: init?.method ?? 'GET',
    headers: init?.json ? { 'content-type': 'application/json' } : undefined,
    body: init?.json ? JSON.stringify(init.json) : undefined,
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe('HTTP API 端到端', () => {
  let id = 0;

  it('health', async () => {
    const r = await api('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('建星座并导入、计算、幂等', async () => {
    const created = await api('/api/constellations', {
      method: 'POST',
      json: { name: '手算', satellites: sats },
    });
    expect(created.status).toBe(200);
    id = created.body.constellation.id;

    const c1 = await api(`/api/constellations/${id}/compute`, {
      method: 'POST',
      json: { cutoffDeg: 0 },
    });
    expect(c1.body.result.status).toBe('OK');
    expect(c1.body.result.metrics.GDOP).toBeCloseTo(Math.sqrt(3), 8);
    expect(c1.body.isNormalPrecision).toBe(true);

    const c2 = await api(`/api/constellations/${id}/compute`, {
      method: 'POST',
      json: { cutoffDeg: 0 },
    });
    expect(c2.body.cached).toBe(true);
    expect(c2.body.reportId).toBe(c1.body.reportId);
  });

  it('矩阵来源可查询', async () => {
    const r = await api(`/api/constellations/${id}/observations`);
    expect(r.body.observations).toHaveLength(4);
  });

  it('逐星移除：4 星移除后不足四颗', async () => {
    const r = await api(`/api/constellations/${id}/leave-one-out`, {
      method: 'POST',
      json: {},
    });
    expect(r.body.comparisons).toHaveLength(4);
    for (const c of r.body.comparisons) {
      expect(c.status).toBe('INSUFFICIENT_SATELLITES');
    }
  });

  it('报告列表与详情', async () => {
    const list = await api(`/api/constellations/${id}/reports`);
    expect(list.body.reports.length).toBeGreaterThan(0);
    const rid = list.body.reports[0].id;
    const one = await api(`/api/reports/${rid}`);
    expect(one.body.result.HtH.length).toBe(4);
  });

  it('非法观测整体拒绝并返回错误码', async () => {
    const bad = sats.slice(0, 2);
    const r = await api('/api/constellations', {
      method: 'POST',
      json: { name: 'bad', satellites: bad },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('SATELLITE_LIMIT');
  });

  it('重复 ID 拒绝', async () => {
    const dup = [...sats, { id: 'A', azimuthDeg: 1, elevationDeg: 1 }];
    const r = await api('/api/constellations', {
      method: 'POST',
      json: { name: 'dup', satellites: dup },
    });
    expect(r.body.error.code).toBe('DUPLICATE_ID');
  });

  it('404 错误码', async () => {
    const r = await api('/api/constellations/999999');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});
