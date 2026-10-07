/**
 * 纯矩阵工具：不使用任何第三方线性代数/DOP 库。
 * 所有函数对 4x4 场景足够稳定，采用部分主元（列内最大绝对值）消元。
 */

export type Matrix = number[][];

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number): Matrix {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i]![i] = 1;
  return m;
}

export function transpose(a: Matrix): Matrix {
  const rows = a.length;
  const cols = a[0]?.length ?? 0;
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) out[j]![i] = a[i]![j]!;
  return out;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const k = b.length;
  const m = b[0]?.length ?? 0;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const aik = a[i]![p]!;
      if (aik === 0) continue;
      for (let j = 0; j < m; j++) out[i]![j]! += aik * b[p]![j]!;
    }
  }
  return out;
}

export function cloneMatrix(a: Matrix): Matrix {
  return a.map((row) => row.slice());
}

/**
 * 对 n x n 矩阵做部分主元 Gauss-Jordan 消元，返回逆矩阵与主元信息。
 *
 * 数值尺度：相对主元容差 pivotTol。第 k 步在第 k..n-1 行第 k 列中选取
 * 绝对值最大的元素；若 |pivot| <= pivotTol * scale（scale 为当前矩阵
 * 最大元素绝对值，或 1 取较大者），判定该列缺失（秩不足）。
 */
export interface InvertResult {
  ok: boolean;
  inverse: Matrix | null;
  pivots: { step: number; row: number; value: number; scale: number; ratio: number }[];
  rank: number;
  singularStep: number | null;
}

export function invertWithPivots(src: Matrix, pivotTol: number): InvertResult {
  const n = src.length;
  const a = cloneMatrix(src);
  const inv = identity(n);
  const pivots: InvertResult["pivots"] = [];
  let rank = 0;

  for (let col = 0; col < n; col++) {
    let globalMax = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) globalMax = Math.max(globalMax, Math.abs(a[i]![j]!));
    const scale = Math.max(globalMax, 1);

    let pivotRow = -1;
    let pivotVal = 0;
    for (let r = col; r < n; r++) {
      const v = Math.abs(a[r]![col]!);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = r;
      }
    }

    const ratio = pivotVal / scale;
    pivots.push({ step: col, row: pivotRow, value: pivotRow >= 0 ? a[pivotRow]![col]! : 0, scale, ratio });

    if (pivotRow < 0 || ratio <= pivotTol) {
      return { ok: false, inverse: null, pivots, rank, singularStep: col };
    }

    if (pivotRow !== col) {
      [a[col], a[pivotRow]] = [a[pivotRow]!, a[col]!];
      [inv[col], inv[pivotRow]] = [inv[pivotRow]!, inv[col]!];
    }

    const pivot = a[col]![col]!;
    for (let j = 0; j < n; j++) {
      a[col]![j] = a[col]![j]! / pivot;
      inv[col]![j] = inv[col]![j]! / pivot;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) {
        a[r]![j]! -= factor * a[col]![j]!;
        inv[r]![j]! -= factor * inv[col]![j]!;
      }
    }
    rank++;
  }

  return { ok: true, inverse: inv, pivots, rank, singularStep: null };
}

/** 两个同形矩阵元素差的最大绝对值。 */
export function maxAbsDiff(a: Matrix, b: Matrix): number {
  let max = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < (a[i]?.length ?? 0); j++) max = Math.max(max, Math.abs(a[i]![j]! - b[i]![j]!));
  return max;
}

/** 矩阵最大元素绝对值（数值尺度参考）。 */
export function maxAbs(a: Matrix): number {
  let max = 0;
  for (const row of a) for (const v of row) max = Math.max(max, Math.abs(v));
  return max;
}
