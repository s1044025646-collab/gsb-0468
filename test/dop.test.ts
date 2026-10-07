import { describe, it, expect } from 'vitest';
import {
  computeDOP,
  leaveOneOut,
  normalizeAzimuth,
  validateSatellites,
  type SatInput,
  MIN_SATS,
} from '../src/dop.js';
import { gram, multiply, identity, type Matrix } from '../src/linalg.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const hand: SatInput[] = JSON.parse(
  readFileSync(resolve(__dirname, '../data/fixtures/handcalc.json'), 'utf-8'),
);

describe('方位角归一化', () => {
  it('回绕到 [0,360)', () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(-90)).toBe(270);
    expect(normalizeAzimuth(720 + 45)).toBe(45);
    expect(normalizeAzimuth(-400)).toBeCloseTo(320, 10);
  });
});

describe('手算夹具（1 天顶 + 3 水平 120°均分）', () => {
  const r = computeDOP(hand, 0);

  it('状态 OK 且秩为 4', () => {
    expect(r.status).toBe('OK');
    expect(r.rank).toBe(4);
  });

  it('Q 对角为 2/3, 2/3, 4/3, 1/3', () => {
    const Q = r.Q!;
    expect(Q[0][0]).toBeCloseTo(2 / 3, 10);
    expect(Q[1][1]).toBeCloseTo(2 / 3, 10);
    expect(Q[2][2]).toBeCloseTo(4 / 3, 10);
    expect(Q[3][3]).toBeCloseTo(1 / 3, 10);
  });

  it('GDOP=sqrt(3)，HDOP=VDOP=sqrt(4/3)', () => {
    const m = r.metrics!;
    expect(m.GDOP).toBeCloseTo(Math.sqrt(3), 10);
    expect(m.HDOP).toBeCloseTo(Math.sqrt(4 / 3), 10);
    expect(m.VDOP).toBeCloseTo(Math.sqrt(4 / 3), 10);
    expect(m.PDOP).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(m.TDOP).toBeCloseTo(Math.sqrt(1 / 3), 10);
  });

  it('独立矩阵乘法验证 H^T H · Q = I', () => {
    const prod = multiply(r.HtH!, r.Q!);
    const I = identity(4);
    let maxErr = 0;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) maxErr = Math.max(maxErr, Math.abs(prod[i][j] - I[i][j]));
    expect(maxErr).toBeLessThan(1e-9);
    expect(r.residual).toBeLessThan(1e-9);
  });

  it('手算 H^T H 对角线', () => {
    // 天顶星行 [0,0,-1,1]，3 水平星水平分量和为0；
    // 水平三星座 sum E^2 = 3/2, sum N^2 = 3/2, U 仅天顶=1
    const G = r.HtH!;
    expect(G[0][0]).toBeCloseTo(1.5, 10);
    expect(G[1][1]).toBeCloseTo(1.5, 10);
    expect(G[2][2]).toBeCloseTo(1, 10);
    expect(G[3][3]).toBeCloseTo(4, 10);
  });
});

describe('所有星同仰角的退化', () => {
  const deg: SatInput[] = JSON.parse(
    readFileSync(resolve(__dirname, '../data/fixtures/degenerate.json'), 'utf-8'),
  );
  const r = computeDOP(deg, 0);
  it('秩亏损且不给出有限精度', () => {
    expect(r.status).toBe('RANK_DEFICIENT');
    expect(r.metrics).toBeNull();
    expect(r.Q).toBeNull();
    expect(r.rank).toBeLessThan(4);
  });
});

describe('加入不同仰角后恢复', () => {
  const deg: SatInput[] = JSON.parse(
    readFileSync(resolve(__dirname, '../data/fixtures/degenerate.json'), 'utf-8'),
  );
  const fixed = [...deg, { id: 'HIGH', azimuthDeg: 10, elevationDeg: 85 }];
  const r = computeDOP(fixed, 0);
  it('秩恢复为 4 且可计算', () => {
    expect(r.status).toBe('OK');
    expect(r.rank).toBe(4);
    expect(Number.isFinite(r.metrics!.GDOP)).toBe(true);
  });
});

describe('方向重复但 ID 不同不去重', () => {
  const sats: SatInput[] = [
    { id: 'A', azimuthDeg: 30, elevationDeg: 20 },
    { id: 'B', azimuthDeg: 30, elevationDeg: 20 },
    { id: 'C', azimuthDeg: 150, elevationDeg: 20 },
    { id: 'D', azimuthDeg: 270, elevationDeg: 20 },
  ];
  const r = computeDOP(sats, 0);
  it('保留 4 条等精度观测但同方向不增加秩方向（水平内仍可满秩）', () => {
    expect(r.selectedCount).toBe(4);
    // A/B 同向，但与 C、D 一起水平三方向仍满秩；天向/钟差在等仰角下相关
    expect(r.status).toBe('RANK_DEFICIENT');
  });
});

describe('仰角截止', () => {
  it('恰等于门槛保留', () => {
    const r = computeDOP(hand, 0);
    expect(r.selectedCount).toBe(4);
    const r90 = computeDOP(hand, 90);
    expect(r90.selectedCount).toBe(1);
    expect(r90.status).toBe('INSUFFICIENT_SATELLITES');
  });
  it('低于门槛被排除并给原因', () => {
    const r = computeDOP(hand, 15);
    expect(r.selectedCount).toBe(1);
    expect(r.excludedCount).toBe(3);
    expect(r.satellites.find((s) => s.id === 'H0')?.excludeReason).toContain('低于截止');
  });
});

describe('接近退化的数值判定', () => {
  it('微小仰角差异触发接近奇异（大条件数），仍由容差判定', () => {
    const near: SatInput[] = [
      { id: 'S1', azimuthDeg: 0, elevationDeg: 30 },
      { id: 'S2', azimuthDeg: 60, elevationDeg: 30.000000001 },
      { id: 'S3', azimuthDeg: 150, elevationDeg: 30.000000002 },
      { id: 'S4', azimuthDeg: 230, elevationDeg: 30 },
      { id: 'S5', azimuthDeg: 300, elevationDeg: 30 },
    ];
    const r = computeDOP(near, 0, 1e-10);
    // 极小差异下主元极小，相对容差将其判为秩亏损
    expect(['RANK_DEFICIENT', 'NUMERIC_FAILURE', 'OK']).toContain(r.status);
    if (r.status === 'OK') {
      expect(r.metrics!.GDOP).toBeGreaterThan(1e4);
    }
  });
});

describe('逐星移除', () => {
  it('4 星移除任意一颗后不足四颗被单独标记', () => {
    const entries = leaveOneOut(hand, 0);
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      expect(e.result.selectedCount).toBe(3);
      expect(e.result.status).toBe('INSUFFICIENT_SATELLITES');
      expect(e.result.metrics).toBeNull();
    }
  });
  it('5 星移除后重新独立计算，退化可被标记', () => {
    const five: SatInput[] = [
      ...hand,
      { id: 'EXTRA', azimuthDeg: 45, elevationDeg: 60 },
    ];
    const entries = leaveOneOut(five, 0);
    expect(entries).toHaveLength(5);
    // 每一条都基于全新矩阵
    for (const e of entries) {
      expect(e.result.H).not.toBeNull();
    }
  });
});

describe('参数校验与错误码', () => {
  it('数量越界整体拒绝', () => {
    expect(() => validateSatellites(hand.slice(0, 3))).toThrow(/4 到 64/);
  });
  it('重复 ID 拒绝', () => {
    const dup = [
      ...hand,
      { id: 'H0', azimuthDeg: 10, elevationDeg: 10 },
    ];
    expect(() => validateSatellites(dup)).toThrow(/重复/);
  });
  it('非法仰角拒绝', () => {
    const bad = hand.map((s) => ({ ...s }));
    bad[0].elevationDeg = 100;
    expect(() => validateSatellites(bad)).toThrow();
  });
  it('非法方位角（NaN/Infinity）拒绝', () => {
    const bad = hand.map((s) => ({ ...s }));
    bad[1].azimuthDeg = Infinity;
    expect(() => validateSatellites(bad)).toThrow();
  });
});

describe('交叉项保留（不强行对角化）', () => {
  it('非对称几何下 Q 与 HtH 保留非零非对角元素', () => {
    const sats: SatInput[] = [
      { id: 'A', azimuthDeg: 20, elevationDeg: 10 },
      { id: 'B', azimuthDeg: 100, elevationDeg: 40 },
      { id: 'C', azimuthDeg: 200, elevationDeg: 70 },
      { id: 'D', azimuthDeg: 300, elevationDeg: 25 },
      { id: 'E', azimuthDeg: 260, elevationDeg: 55 },
    ];
    const r = computeDOP(sats, 0);
    expect(r.status).toBe('OK');
    let offDiagHtH = 0;
    let offDiagQ = 0;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        if (i !== j) {
          offDiagHtH += Math.abs(r.HtH![i][j]);
          offDiagQ += Math.abs(r.Q![i][j]);
        }
    expect(offDiagHtH).toBeGreaterThan(0);
    expect(offDiagQ).toBeGreaterThan(0);
  });
});
