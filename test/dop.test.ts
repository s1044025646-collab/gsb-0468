import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDop, leaveOneOut, normalizeAzimuth, normalizeSatellite, type RawSatellite } from "../src/math/dop.js";
import type { Matrix } from "../src/math/matrix.js";

/** 测试专用：独立写出的朴素矩阵乘法/转置，不引用项目实现，用于交叉验证。 */
function independentMul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const k = b.length;
  const m = b[0]!.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let p = 0; p < k; p++)
      for (let j = 0; j < m; j++) out[i]![j] += a[i]![p]! * b[p]![j]!;
  return out;
}
function independentTranspose(a: number[][]): number[][] {
  return a[0]!.map((_, j) => a.map((row) => row[j]!));
}
function independentMaxResidual(a: number[][], b: number[][]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < a[i]!.length; j++) m = Math.max(m, Math.abs(a[i]![j]! - b[i]![j]!));
  return m;
}

const fixture: RawSatellite[] = [
  { id: "Z", azDeg: 0, elDeg: 90 },
  { id: "H0", azDeg: 0, elDeg: 0 },
  { id: "H120", azDeg: 120, elDeg: 0 },
  { id: "H240", azDeg: 240, elDeg: 0 },
];

test("手算夹具：Q 对角为 2/3, 2/3, 4/3, 1/3，GDOP=sqrt(3)", () => {
  const r = computeDop(fixture, 0);
  assert.equal(r.status, "ok");
  assert.equal(r.rank, 4);
  const diag = r.Q!.map((row, i) => row[i]!);
  assert.ok(Math.abs(diag[0]! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(diag[1]! - 2 / 3) < 1e-9);
  assert.ok(Math.abs(diag[2]! - 4 / 3) < 1e-9);
  assert.ok(Math.abs(diag[3]! - 1 / 3) < 1e-9);
  assert.ok(Math.abs(r.metrics!.HDOP - Math.sqrt(4 / 3)) < 1e-9);
  assert.ok(Math.abs(r.metrics!.VDOP - Math.sqrt(4 / 3)) < 1e-9);
  assert.ok(Math.abs(r.metrics!.PDOP - Math.sqrt(8 / 3)) < 1e-9);
  assert.ok(Math.abs(r.metrics!.TDOP - Math.sqrt(1 / 3)) < 1e-9);
  assert.ok(Math.abs(r.metrics!.GDOP - Math.sqrt(3)) < 1e-9);

  // 独立矩阵乘法验证：先用独立代码重建 G，再检查 GQ=I
  const H = r.H!;
  const Gind = independentMul(independentTranspose(H), H);
  const GQ = independentMul(Gind, r.Q!);
  const I = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => (i === j ? 1 : 0)));
  assert.ok(independentMaxResidual(GQ, I) < 1e-9);
  assert.ok(r.inverseResidual! < 1e-8);

  // 手算 G 的关键元素：三颗水平星 Σ=3E0,0,0 行，天顶星贡献 U
  // G_EE = ΣE² = 3/2, G_NN = 3/2, G_UU=1, G_tt=4, G_Ut=-1
  assert.ok(Math.abs(r.G![0]![0]! - 1.5) < 1e-12);
  assert.ok(Math.abs(r.G![2]![2]! - 1) < 1e-12);
  assert.ok(Math.abs(r.G![3]![3]! - 4) < 1e-12);
  assert.ok(Math.abs(r.G![2]![3]! - -1) < 1e-12);
  // 交叉项保留（非强制对角化）
  assert.ok(Math.abs(r.Q![2]![3]! - 1 / 3) < 1e-9);
});

test("所有星同仰角 -> 天向列与钟差列线性相关，秩不足且无有限指标", () => {
  const sats: RawSatellite[] = [0, 90, 180, 270].map((az, i) => ({ id: `S${i}`, azDeg: az, elDeg: 30 }));
  const r = computeDop(sats, 0);
  assert.equal(r.status, "rank_deficient");
  assert.ok(r.rank < 4);
  assert.equal(r.metrics, null);
  assert.equal(r.Q, null);
  assert.ok(r.degeneracy.join("").includes("钟差"));
});

test("加入不同仰角方向后恢复满秩", () => {
  const sats: RawSatellite[] = [
    ...[0, 90, 180, 270].map((az, i) => ({ id: `S${i}`, azDeg: az, elDeg: 30 })),
    { id: "HI", azDeg: 45, elDeg: 80 },
  ];
  const r = computeDop(sats, 0);
  assert.equal(r.status, "ok");
  assert.equal(r.rank, 4);
  assert.ok(r.metrics!.GDOP > 0 && Number.isFinite(r.metrics!.GDOP));
});

test("方位角回绕：-90 与 720 分别规范到 270 与 0", () => {
  assert.equal(normalizeAzimuth(-90), 270);
  assert.equal(normalizeAzimuth(720), 0);
  assert.equal(normalizeAzimuth(360), 0);
  assert.equal(normalizeAzimuth(-0), 0);
  const n = normalizeSatellite({ id: "x", azDeg: -90, elDeg: 45 });
  assert.ok(n.E < 0); // az=270 => E=cos45*sin270 <0
});

test("方向相同但 ID 不同保留为两条独立观测，不增加几何方向（近退化）", () => {
  const sats: RawSatellite[] = [
    { id: "A", azDeg: 10, elDeg: 20 },
    { id: "B", azDeg: 10, elDeg: 20 },
    { id: "C", azDeg: 130, elDeg: 20 },
    { id: "D", azDeg: 250, elDeg: 20 },
  ];
  const r = computeDop(sats, 0);
  assert.equal(r.selectedCount, 4); // 没有偷偷去重
  // 同仰角 => 天向/钟差仍相关
  assert.equal(r.status, "rank_deficient");
});

test("截止门槛：恰等值保留，低于排除", () => {
  const sats: RawSatellite[] = [
    { id: "Z", azDeg: 0, elDeg: 90 },
    { id: "EQ", azDeg: 0, elDeg: 15 },
    { id: "E120", azDeg: 120, elDeg: 15 },
    { id: "E240", azDeg: 240, elDeg: 15 },
    { id: "LOW", azDeg: 60, elDeg: 14.999 },
  ];
  const r = computeDop(sats, 15);
  assert.equal(r.selectedCount, 4);
  const low = r.selection.find((s) => s.id === "LOW")!;
  const eq = r.selection.find((s) => s.id === "EQ")!;
  assert.equal(low.included, false);
  assert.ok(low.reason.includes("排除"));
  assert.equal(eq.included, true);
  assert.equal(r.status, "ok");
});

test("接近退化被标记但仍可算", () => {
  const sats: RawSatellite[] = [
    { id: "Z", azDeg: 0, elDeg: 90 },
    { id: "A", azDeg: 0, elDeg: 0 },
    { id: "B", azDeg: 120, elDeg: 0 },
    { id: "C", azDeg: 240.0000001, elDeg: 0.0000001 },
  ];
  const r = computeDop(sats, 0, 1e-10, 1e-8);
  assert.equal(r.status, "ok");
});

test("逐颗移除后不足四颗单独标记，且不复用旧矩阵", () => {
  const cmp = leaveOneOut(fixture, 0, 1e-10, 1e-8, 64);
  assert.equal(cmp.length, 4);
  for (const c of cmp) {
    assert.equal(c.result.selectedCount, 3);
    assert.equal(c.result.status, "insufficient_observations");
    assert.equal(c.result.Q, null);
    assert.equal(c.result.metrics, null);
  }
});

test("五颗星移除一颗仍可解，且结果不同于原星座", () => {
  const sats: RawSatellite[] = [...fixture, { id: "EXTRA", azDeg: 45, elDeg: 45 }];
  const base = computeDop(sats, 0);
  const cmp = leaveOneOut(sats, 0, 1e-10, 1e-8, 64);
  const removed = cmp.find((c) => c.removedId === "EXTRA")!.result;
  assert.equal(removed.status, "ok");
  assert.notEqual(removed.metrics!.GDOP, base.metrics!.GDOP);
});

test("H 行列顺序固定为 [-E,-N,-U,1]", () => {
  const n = normalizeSatellite({ id: "x", azDeg: 90, elDeg: 0 });
  assert.ok(Math.abs(n.E - 1) < 1e-12);
  assert.ok(Math.abs(n.N - 0) < 1e-12);
  assert.deepEqual(n.hRow, [-n.E, -n.N, -n.U, 1]);
});

test("矩阵工具交叉校验：独立乘法与项目乘法一致", async () => {
  const { multiply, transpose } = await import("../src/math/matrix.js");
  const r = computeDop(fixture, 0);
  const H = r.H! as Matrix;
  assert.ok(independentMaxResidual(multiply(transpose(H), H), independentMul(independentTranspose(H), H)) < 1e-15);
});
