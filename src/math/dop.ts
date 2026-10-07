/**
 * GNSS 星座几何核心：方向规范化、几何矩阵 H、G = HᵀH、
 * 带主元秩判定、Q = G⁻¹、DOP 指标与退化解释。
 *
 * 约定：
 *  - 方位角 az：从正北顺时针，单位度，接受任意有限值，规范到 [0,360)。
 *  - 仰角 el：相对水平面向上，单位度，必须在 [0,90]。
 *  - 视线单位向量（站心 ENU）：
 *      E = cos(el) sin(az), N = cos(el) cos(az), U = sin(el)
 *  - 几何矩阵每行：H = [-E, -N, -U, 1]，列顺序固定 [东, 北, 天, 钟差]。
 */

import { identity, invertWithPivots, maxAbs, maxAbsDiff, multiply, transpose, type Matrix } from "./matrix.js";

export const DOP_DIM = 4;

/** 默认相对主元容差与逆矩阵残差容差（公开，可配置）。 */
export const DEFAULT_PIVOT_TOL = 1e-10;
export const DEFAULT_RESIDUAL_TOL = 1e-8;
/** 允许在“舍入误差范围”内修正近零负对角的阈值。 */
export const NEAR_ZERO_NEG_TOL = 1e-10;

export interface RawSatellite {
  id: string;
  azDeg: number;
  elDeg: number;
}

export interface NormalizedSatellite extends RawSatellite {
  azNormDeg: number;
  elRad: number;
  azRad: number;
  E: number;
  N: number;
  U: number;
  hRow: [number, number, number, number];
}

export interface SelectionEntry {
  id: string;
  included: boolean;
  reason: string;
}

export interface DopMetrics {
  HDOP: number;
  VDOP: number;
  PDOP: number;
  TDOP: number;
  GDOP: number;
}

export type ReportStatus = "ok" | "rank_deficient" | "numeric_failure" | "insufficient_observations";

export interface DopResult {
  status: ReportStatus;
  cutoffDeg: number;
  pivotTol: number;
  residualTol: number;
  observationCount: number;
  selectedCount: number;
  selection: SelectionEntry[];
  satellites: NormalizedSatellite[];
  /** 仅入选卫星组成的 H 矩阵（列：E,N,U,clock）。 */
  H: Matrix | null;
  G: Matrix | null;
  Q: Matrix | null;
  rank: number;
  pivots: ReturnType<typeof invertWithPivots>["pivots"];
  singularStep: number | null;
  inverseResidual: number | null;
  metrics: DopMetrics | null;
  /** 数值尺度与失败/告警说明。 */
  scaleGH: number | null;
  diagnostics: string[];
  degeneracy: string[];
}

export function normalizeAzimuth(azDeg: number): number {
  let a = azDeg % 360;
  if (a < 0) a += 360;
  return a === 360 || Object.is(a, -0) ? 0 : a;
}

export function normalizeSatellite(sat: RawSatellite): NormalizedSatellite {
  const azNormDeg = normalizeAzimuth(sat.azDeg);
  const elRad = (sat.elDeg * Math.PI) / 180;
  const azRad = (azNormDeg * Math.PI) / 180;
  const cosEl = Math.cos(elRad);
  const E = cosEl * Math.sin(azRad);
  const N = cosEl * Math.cos(azRad);
  const U = Math.sin(elRad);
  return {
    ...sat,
    azNormDeg,
    elRad,
    azRad,
    E,
    N,
    U,
    hRow: [-E, -N, -U, 1],
  };
}

/**
 * 主计算入口。
 * @param satellites 已通过整体校验的原始观测
 * @param cutoffDeg 仰角截止值，恰等于门槛的卫星保留
 */
export function computeDop(
  satellites: RawSatellite[],
  cutoffDeg: number,
  pivotTol: number = DEFAULT_PIVOT_TOL,
  residualTol: number = DEFAULT_RESIDUAL_TOL,
): DopResult {
  const normalized = satellites.map(normalizeSatellite);
  const selection: SelectionEntry[] = normalized.map((s) => {
    if (s.elDeg < cutoffDeg)
      return { id: s.id, included: false, reason: `仰角 ${s.elDeg}° 低于截止值 ${cutoffDeg}°，排除` };
    return { id: s.id, included: true, reason: `仰角 ${s.elDeg}° >= 截止值 ${cutoffDeg}°（恰等保留），入选` };
  });

  const selected = normalized.filter((_, i) => selection[i]!.included);
  const diagnostics: string[] = [];
  const degeneracy: string[] = [];

  const base: DopResult = {
    status: "insufficient_observations",
    cutoffDeg,
    pivotTol,
    residualTol,
    observationCount: normalized.length,
    selectedCount: selected.length,
    selection,
    satellites: normalized,
    H: null,
    G: null,
    Q: null,
    rank: 0,
    pivots: [],
    singularStep: null,
    inverseResidual: null,
    metrics: null,
    scaleGH: null,
    diagnostics,
    degeneracy,
  };

  if (selected.length < DOP_DIM) {
    diagnostics.push(`入选观测 ${selected.length} 条，少于未知数个数 4（东、北、天、钟差），不构成可解系统。`);
    return { ...base, H: buildH(selected) };
  }

  const H = buildH(selected);
  const G = multiply(transpose(H), H);
  const scaleGH = Math.max(maxAbs(H), maxAbs(G), 1);
  const inv = invertWithPivots(G, pivotTol);

  if (!inv.ok || inv.inverse === null) {
    diagnostics.push(
      `G = HᵀH 秩不足：在第 ${inv.singularStep} 个主元处 |pivot|/scale = ${
        inv.pivots[inv.singularStep ?? 0]?.ratio ?? 0
      } <= 相对主元容差 ${pivotTol}。四个未知数中存在线性相关方向，Q 不存在有限值。`,
    );
    explainDegeneracy(selected, degeneracy);
    return {
      ...base,
      status: "rank_deficient",
      H,
      G,
      rank: inv.rank,
      pivots: inv.pivots,
      singularStep: inv.singularStep,
      scaleGH,
    };
  }

  const Q = symmetrizeNearZero(inv.inverse, diagnostics);

  for (let k = 0; k < DOP_DIM; k++) {
    if (Q[k]![k]! < -NEAR_ZERO_NEG_TOL) {
      diagnostics.push(`Q 的第 ${k} 个对角元为明显负值 ${Q[k]![k]}，协方差式矩阵不应出现，判定数值失败。`);
      return failNumeric(base, H, G, Q, inv, scaleGH, diagnostics, degeneracy);
    }
  }

  const residual = maxAbsDiff(multiply(G, Q), identity(DOP_DIM));
  if (residual > residualTol) {
    diagnostics.push(
      `逆矩阵验证失败：max|GQ - I| = ${residual} > 残差容差 ${residualTol}，结果不可信，判定数值失败。`,
    );
    return failNumeric(base, H, G, Q, inv, scaleGH, diagnostics, degeneracy, residual);
  }

  const metrics = metricsFromQ(Q);
  if (inv.rank < DOP_DIM) {
    return failNumeric(base, H, G, Q, inv, scaleGH, diagnostics, degeneracy, residual);
  }

  if (residual > residualTol * 1e-2)
    diagnostics.push(`注意：逆矩阵残差 ${residual} 已接近残差容差 ${residualTol}，几何接近退化，指标放大明显。`);
  warnNearDegenerate(inv, pivotTol, degeneracy, diagnostics);

  return {
    ...base,
    status: "ok",
    H,
    G,
    Q,
    rank: inv.rank,
    pivots: inv.pivots,
    singularStep: null,
    inverseResidual: residual,
    metrics,
    scaleGH,
  };
}

function buildH(selected: NormalizedSatellite[]): Matrix {
  return selected.map((s) => [...s.hRow]);
}

function failNumeric(
  base: DopResult,
  H: Matrix,
  G: Matrix,
  Q: Matrix,
  inv: ReturnType<typeof invertWithPivots>,
  scaleGH: number,
  diagnostics: string[],
  degeneracy: string[],
  residual?: number,
): DopResult {
  explainDegeneracy(base.satellites.filter((s) => s.elDeg >= base.cutoffDeg), degeneracy);
  return {
    ...base,
    status: "numeric_failure",
    H,
    G,
    Q,
    rank: inv.rank,
    pivots: inv.pivots,
    singularStep: inv.singularStep,
    inverseResidual: residual ?? null,
    scaleGH,
    diagnostics,
    degeneracy,
  };
}

/**
 * 仅在公开的极小舍入阈值内，把近零负对角归零，保持交叉项不变；
 * 不把矩阵强行改成对角矩阵。
 */
function symmetrizeNearZero(Q: Matrix, diagnostics: string[]): Matrix {
  const out = Q.map((row) => row.slice());
  for (let k = 0; k < DOP_DIM; k++) {
    if (out[k]![k]! < 0 && out[k]![k]! >= -NEAR_ZERO_NEG_TOL) {
      diagnostics.push(`Q[${k}][${k}] = ${out[k]![k]} 为舍入量级近零负值，按容差 ${NEAR_ZERO_NEG_TOL} 修正为 0；交叉项保留。`);
      out[k]![k] = 0;
    }
  }
  return out;
}

function metricsFromQ(Q: Matrix): DopMetrics {
  const qEE = Q[0]![0]!;
  const qNN = Q[1]![1]!;
  const qUU = Q[2]![2]!;
  const qTT = Q[3]![3]!;
  const trace = qEE + qNN + qUU + qTT;
  return {
    HDOP: Math.sqrt(qEE + qNN),
    VDOP: Math.sqrt(qUU),
    PDOP: Math.sqrt(qEE + qNN + qUU),
    TDOP: Math.sqrt(qTT),
    GDOP: Math.sqrt(trace),
  };
}

/** 教学性退化解释：检测所有入选星仰角相同导致天向列与钟差列相关。 */
function explainDegeneracy(selected: NormalizedSatellite[], out: string[]): void {
  if (selected.length === 0) return;
  const el0 = selected[0]!.elDeg;
  const sameEl = selected.every((s) => Math.abs(s.elDeg - el0) < 1e-9);
  if (sameEl) {
    out.push(
      `全部 ${selected.length} 颗入选星仰角相同（${el0}°）：H 的天向列 -U=-sin(el) 为常数，与钟差列 1 线性相关，G 秩不足，天向/钟差不可解。`,
    );
  }
}

function warnNearDegenerate(
  inv: ReturnType<typeof invertWithPivots>,
  pivotTol: number,
  degeneracy: string[],
  diagnostics: string[],
): void {
  const minRatio = Math.min(...inv.pivots.map((p) => p.ratio));
  if (minRatio < Math.sqrt(pivotTol)) {
    const msg = `最小相对主元比 ${minRatio.toExponential(3)} 接近容差 ${pivotTol}，星座几何接近退化，DOP 对小角度变化高度敏感。`;
    degeneracy.push(msg);
    diagnostics.push(msg);
  }
}

/** 逐颗移除比较：始终基于同一原始输入与门槛重新独立计算，不复用旧矩阵。 */
export function leaveOneOut(
  satellites: RawSatellite[],
  cutoffDeg: number,
  pivotTol: number = DEFAULT_PIVOT_TOL,
  residualTol: number = DEFAULT_RESIDUAL_TOL,
  maxCandidates: number,
): { removedId: string; result: DopResult }[] {
  if (satellites.length > maxCandidates)
    throw new Error(`BATCH_LIMIT_EXCEEDED: 批量比较上限 ${maxCandidates}，当前 ${satellites.length}`);
  return satellites.map((s) => {
    const rest = satellites.filter((x) => x.id !== s.id);
    return { removedId: s.id, result: computeDop(rest, cutoffDeg, pivotTol, residualTol) };
  });
}
