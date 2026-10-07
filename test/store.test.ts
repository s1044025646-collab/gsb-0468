import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import { computeDOP, type SatInput } from '../src/dop.js';

const tmpDir = resolve(__dirname, '../data/.tmp-test');
const dbPath = resolve(tmpDir, 'test.db');
let store: Store;

const sats: SatInput[] = [
  { id: 'Z', azimuthDeg: 0, elevationDeg: 90 },
  { id: 'A', azimuthDeg: 0, elevationDeg: 0 },
  { id: 'B', azimuthDeg: 120, elevationDeg: 0 },
  { id: 'C', azimuthDeg: 240, elevationDeg: 0 },
];

beforeEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  store = new Store(dbPath);
});
afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('版本化与冻结结果', () => {
  it('导入产生新版本，报告幂等', () => {
    const c = store.createConstellation('t');
    const v1 = store.importObservations(c.id, sats);
    expect(v1).toBe(2); // create 后 version=1，首次导入为 2
    const r = computeDOP(store.getObservations(c.id), 0);
    const a = store.upsertReport(c.id, v1, 0, 1e-10, r);
    expect(a.created).toBe(true);
    const b = store.upsertReport(c.id, v1, 0, 1e-10, r);
    expect(b.created).toBe(false);
    expect(b.report.id).toBe(a.report.id);
  });

  it('修改观测产生新版本，可核对历史矩阵', () => {
    const c = store.createConstellation('t');
    store.importObservations(c.id, sats);
    const changed = sats.map((s) =>
      s.id === 'A' ? { ...s, elevationDeg: 10 } : s,
    );
    const v2 = store.importObservations(c.id, changed);
    expect(store.listVersions(c.id)).toEqual([2, 3]);
    const oldA = store.getObservations(c.id, 2).find((s) => s.id === 'A');
    const newA = store.getObservations(c.id, v2).find((s) => s.id === 'A');
    expect(oldA!.elevationDeg).toBe(0);
    expect(newA!.elevationDeg).toBe(10);
  });

  it('计算失败也保存诊断但不标为正常精度', () => {
    const c = store.createConstellation('t');
    const deg: SatInput[] = [
      { id: '1', azimuthDeg: 0, elevationDeg: 30 },
      { id: '2', azimuthDeg: 60, elevationDeg: 30 },
      { id: '3', azimuthDeg: 150, elevationDeg: 30 },
      { id: '4', azimuthDeg: 230, elevationDeg: 30 },
    ];
    const v = store.importObservations(c.id, deg);
    const r = computeDOP(deg, 0);
    expect(r.status).not.toBe('OK');
    const { report } = store.upsertReport(c.id, v, 0, 1e-10, r);
    expect(report.is_normal_precision).toBe(0);
    expect(JSON.parse(report.result_json).status).toBe(r.status);
  });
});
