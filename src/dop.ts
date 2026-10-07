import { AppError } from './errors.js';
import {
  type Matrix,
  gram,
  inverseWithDiag,
  multiply,
  identity,
  maxAbs,
} from './linalg.js';

export interface SatInput {
  id: string;
  azimuthDeg: number; // 正北顺时针，任意有限度
  elevationDeg: number; // 0..90
}

export interface SatDirection {
  id: string;
  azimuthRaw: number;
  elevationRaw: number;
  azimuthNormalized: number; // [0,360)
  elevation: number;
  E: number;
  N: number;
  U: number;
  rowH: number[]; // [-E,-N,-U,1]
  selected: boolean;
  excludeReason?: string;
}

export interface PivotInfo {
  values: number[];
  scale: number;
  relTolerance: number;
  absTolerance: number;
  rank: number;
}

export interface DopMetrics {
  HDOP: number;
  VDOP: number;
  PDOP: number;
  TDOP: number;
  GDOP: number;
}

export type ComputeStatus =
  | 'OK'
  | 'INSUFFICIENT_SATELLITES'
  | 'RANK_DEFICIENT'
  | 'NUMERIC_FAILURE';

export interface ComputeResult {
  status: ComputeStatus;
  reason?: string;
  cutoffDeg: number;
  selectedCount: number;
  excludedCount: number;
  satellites: SatDirection[];
  H: Matrix | null; // 仅入选卫星
  HtH: Matrix | null;
  Q: Matrix | null; // (H^T H)^-1
  rank: number | null;
  pivot: PivotInfo | null;
  residual: number | null; // ||HtH*Q - I||max
  metrics: DopMetrics | null;
  relTolerance: number;
  nearZeroFixes: number; // 在容差内被修正的近零负对角个数
}

export const MIN_SATS = 4;
export const MAX_SATS = 64;
export const MAX_BATCH = 64;
export const DEFAULT_REL_TOL = 1e-10;
export const RESIDUAL_TOL = 1e-7;

const D2R = Math.PI / 180;

export function normalizeAzimuth(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  return a;
}

export function validateSatellites(input: SatInput[]): void {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError('EMPTY_CONSTELLATION', '星座不能为空');
  }
  if (input.length < MIN_SATS || input.length > MAX_SATS) {
    throw new AppError(
      'SATELLITE_LIMIT',
      `卫星数量必须在 ${MIN_SATS} 到 ${MAX_SATS} 之间，收到 ${input.length} 颗`,
    );
  }
  const seen = new Set<string>();
  for (const s of input) {
    if (typeof s?.id !== 'string' || s.id.trim() === '') {
      throw new AppError('INVALID_PARAMS', '卫星 ID 必须为非空字符串', s);
    }
    if (seen.has(s.id)) {
      throw new AppError('DUPLICATE_ID', `卫星 ID 重复：${s.id}`);
    }
    seen.add(s.id);
    if (
      typeof s.azimuthDeg !== 'number' ||
      !Number.isFinite(s.azimuthDeg)
    ) {
      throw new AppError('INVALID_ANGLE', `卫星 ${s.id} 方位角必须为有限数值`);
    }
    if (
      typeof s.elevationDeg !== 'number' ||
      !Number.isFinite(s.elevationDeg) ||
      s.elevationDeg < 0 ||
      s.elevationDeg > 90
    ) {
      throw new AppError(
        'INVALID_ANGLE',
        `卫星 ${s.id} 仰角必须为 0 到 90 度之间的有限数值`,
      );
    }
  }
}

function directionOf(s: SatInput): SatDirection {
  const az = normalizeAzimuth(s.azimuthDeg) * D2R;
  const el = s.elevationDeg * D2R;
  const E = Math.cos(el) * Math.sin(az);
  const N = Math.cos(el) * Math.cos(az);
  const U = Math.sin(el);
  return {
    id: s.id,
    azimuthRaw: s.azimuthDeg,
    elevationRaw: s.elevationDeg,
    azimuthNormalized: normalizeAzimuth(s.azimuthDeg),
    elevation: s.elevationDeg,
    E,
    N,
    U,
    rowH: [-E, -N, -U, 1],
    selected: false,
  };
}

// 计算一个给定星座（已校验）在指定仰角截止下的 DOP。
export function computeDOP(
  input: SatInput[],
  cutoffDeg = 0,
  relTolerance: number = DEFAULT_REL_TOL,
): ComputeResult {
  if (
    typeof cutoffDeg !== 'number' ||
    !Number.isFinite(cutoffDeg) ||
    cutoffDeg < 0 ||
    cutoffDeg > 90
  ) {
    throw new AppError(
      'INVALID_PARAMS',
      '仰角截止值必须为 0 到 90 之间的有限数值',
    );
  }
  if (
    typeof relTolerance !== 'number' ||
    !Number.isFinite(relTolerance) ||
    relTolerance <= 0 ||
    relTolerance >= 1
  ) {
    throw new AppError('INVALID_PARAMS', '相对主元容差必须为 (0,1) 内的有限数值');
  }

  const sats = input.map(directionOf);
  for (const s of sats) {
    // 恰等于门槛保留（>= 入选）
    if (s.elevation + 1e-12 >= cutoffDeg) {
      s.selected = true;
    } else {
      s.selected = false;
      s.excludeReason = `仰角 ${s.elevation}° 低于截止值 ${cutoffDeg}°`;
    }
  }
  const selected = sats.filter((s) => s.selected);
  const base: Omit<ComputeResult, 'status' | 'reason'> = {
    cutoffDeg,
    selectedCount: selected.length,
    excludedCount: sats.length - selected.length,
    satellites: sats,
    H: null,
    HtH: null,
    Q: null,
    rank: null,
    pivot: null,
    residual: null,
    metrics: null,
    relTolerance,
    nearZeroFixes: 0,
  };

  if (selected.length < MIN_SATS) {
    return {
      ...base,
      status: 'INSUFFICIENT_SATELLITES',
      reason: `入选卫星 ${selected.length} 颗，少于可解所需的 ${MIN_SATS} 颗`,
    };
  }

  const H = selected.map((s) => s.rowH.slice());
  const HtH = gram(H); // 4x4
  const inv = inverseWithDiag(HtH, relTolerance);
  const pivot: PivotInfo = {
    values: inv.pivotValues,
    scale: inv.scale,
    relTolerance,
    absTolerance: inv.tolerance,
    rank: inv.rank,
  };

  if (inv.singular) {
    return {
      ...base,
      H,
      HtH,
      rank: inv.rank,
      pivot,
      status: 'RANK_DEFICIENT',
      reason: `H^T H 秩为 ${inv.rank} < 4，几何退化（至少一个方向不可解，常见于天向列与钟差列线性相关）`,
    };
  }

  const Q = inv.inverse!;
  // 独立残差核对 HtH * Q ≈ I（inverseWithDiag 内已算，这里再独立乘一次）
  const recheck = multiply(HtH, Q);
  const I = identity(4);
  let residual = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      residual = Math.max(residual, Math.abs(recheck[i][j] - I[i][j]));
    }
  }
  void inv.residual;

  // 近零负对角修正：仅在容差范围内的微小负值视为舍入误差。
  let nearZeroFixes = 0;
  for (let i = 0; i < 4; i++) {
    if (Q[i][i] < 0) {
      if (Q[i][i] > -Math.max(RESIDUAL_TOL, relTolerance) * Math.max(1, maxAbs(Q))) {
        Q[i][i] = 0;
        nearZeroFixes++;
      } else {
        return {
          ...base,
          H,
          HtH,
          Q,
          rank: inv.rank,
          pivot,
          residual,
          status: 'NUMERIC_FAILURE',
          reason: `Q 的对角元素 Q[${i}][${i}]=${Q[i][i]} 为明显负值，逆矩阵不可信`,
        };
      }
    }
  }
  if (residual > RESIDUAL_TOL) {
    return {
      ...base,
      H,
      HtH,
      Q,
      rank: inv.rank,
      pivot,
      residual,
      status: 'NUMERIC_FAILURE',
      reason: `H^T H·Q 与单位矩阵最大残差 ${residual.toExponential(3)} 超过容差 ${RESIDUAL_TOL}`,
    };
  }

  const qEE = Q[0][0];
  const qNN = Q[1][1];
  const qUU = Q[2][2];
  const qTT = Q[3][3];
  const metrics: DopMetrics = {
    HDOP: Math.sqrt(qEE + qNN),
    VDOP: Math.sqrt(qUU),
    PDOP: Math.sqrt(qEE + qNN + qUU),
    TDOP: Math.sqrt(qTT),
    GDOP: Math.sqrt(qEE + qNN + qUU + qTT),
  };

  return {
    ...base,
    H,
    HtH,
    Q,
    rank: inv.rank,
    pivot,
    residual,
    metrics,
    nearZeroFixes,
    status: 'OK',
  };
}

// 逐颗移除比较：对同一原始输入与门槛重新计算（不复用上一份矩阵）。
export interface LeaveOneOutEntry {
  removedId: string;
  result: ComputeResult;
}

export function leaveOneOut(
  input: SatInput[],
  cutoffDeg = 0,
  relTolerance: number = DEFAULT_REL_TOL,
): LeaveOneOutEntry[] {
  if (input.length > MAX_BATCH) {
    throw new AppError(
      'BATCH_LIMIT',
      `逐星移除比较最多 ${MAX_BATCH} 颗，收到 ${input.length} 颗`,
    );
  }
  for (const s of input) {
    if (
      typeof s?.id !== 'string' ||
      s.id.trim() === '' ||
      typeof s.azimuthDeg !== 'number' ||
      !Number.isFinite(s.azimuthDeg) ||
      typeof s.elevationDeg !== 'number' ||
      !Number.isFinite(s.elevationDeg) ||
      s.elevationDeg < 0 ||
      s.elevationDeg > 90
    ) {
      throw new AppError('INVALID_ANGLE', `卫星 ${s?.id} 角度非法`);
    }
  }
  return input.map((s) => {
    const reduced = input.filter((x) => x.id !== s.id);
    // reduced 可能少于 4 颗；computeDOP 本体不做数量限制，直接重新计算，
    // 失败结果使用全新矩阵，绝不复用上一份有效结果。
    const result = computeDOP(reduced, cutoffDeg, relTolerance);
    return { removedId: s.id, result };
  });
}
