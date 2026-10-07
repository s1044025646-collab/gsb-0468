// 纯手写线性代数：矩阵乘法、列主元 LU、秩判定、逆、残差。
// 不使用任何现成 DOP / 数值库。

export type Matrix = number[][];

export function zeros(m: number, n: number): Matrix {
  return Array.from({ length: m }, () => new Array<number>(n).fill(0));
}

export function identity(n: number): Matrix {
  const I = zeros(n, n);
  for (let i = 0; i < n; i++) I[i][i] = 1;
  return I;
}

export function clone(A: Matrix): Matrix {
  return A.map((row) => row.slice());
}

// C = A * B
export function multiply(A: Matrix, B: Matrix): Matrix {
  const m = A.length;
  const k = B.length;
  const n = B[0]?.length ?? 0;
  if (k === 0 || A[0].length !== k) {
    throw new Error('矩阵维度不匹配，无法相乘');
  }
  const C = zeros(m, n);
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < k; p++) {
      const a = A[i][p];
      if (a === 0) continue;
      const Brow = B[p];
      const Crow = C[i];
      for (let j = 0; j < n; j++) Crow[j] += a * Brow[j];
    }
  }
  return C;
}

// C = A^T * A
export function gram(A: Matrix): Matrix {
  const m = A.length;
  const n = A[0].length;
  const G = zeros(n, n);
  for (let i = 0; i < m; i++) {
    const row = A[i];
    for (let p = 0; p < n; p++) {
      const ap = row[p];
      for (let q = 0; q < n; q++) G[p][q] += ap * row[q];
    }
  }
  return G;
}

// 转置
export function transpose(A: Matrix): Matrix {
  const m = A.length;
  const n = A[0].length;
  const T = zeros(n, m);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) T[j][i] = A[i][j];
  return T;
}

export function maxAbs(A: Matrix): number {
  let v = 0;
  for (const row of A) for (const x of row) v = Math.max(v, Math.abs(x));
  return v;
}

export interface LuResult {
  // 全主元（行+列交换）Gauss 消元，单位下三角隐式
  LU: Matrix;
  rowPiv: number[]; // 行置换 P（全局）：pb = b[P]
  colPiv: number[]; // 列置换 Q（全局）：x = Q y
  rank: number;
  pivotValues: number[]; // 各主元（绝对值）
  scale: number; // 输入矩阵最大绝对值
  tolerance: number; // 使用的相对主元容差
}

// 全主元 LU 分解（原地消元），返回秩与主元信息。
// 对对称（半）正定矩阵也能正确判秩：在剩余子矩阵中选全局最大元素。
// relTol 为相对容差：主元 < relTol * scale 视为零。
export function luPartialPivot(A: Matrix, relTol = 1e-10): LuResult {
  const m = A.length;
  const n = A[0].length;
  const LU = clone(A);
  const pivotValues: number[] = [];
  const rowPiv = Array.from({ length: m }, (_, i) => i);
  const colPiv = Array.from({ length: n }, (_, i) => i);
  const scale = Math.max(maxAbs(A), Number.MIN_VALUE);
  const tolerance = relTol * scale;
  let rank = 0;

  const steps = Math.min(m, n);
  for (let k = 0; k < steps; k++) {
    // 在剩余子矩阵 [k.., k..] 中找绝对值最大元素
    let maxRow = k;
    let maxCol = k;
    let maxVal = 0;
    for (let i = k; i < m; i++) {
      for (let j = k; j < n; j++) {
        const v = Math.abs(LU[i][j]);
        if (v > maxVal) {
          maxVal = v;
          maxRow = i;
          maxCol = j;
        }
      }
    }
    pivotValues.push(maxVal);
    if (maxVal <= tolerance) {
      continue; // 该列无有效主元，保持秩不增
    }
    if (maxRow !== k) {
      [LU[k], LU[maxRow]] = [LU[maxRow], LU[k]];
      [rowPiv[k], rowPiv[maxRow]] = [rowPiv[maxRow], rowPiv[k]];
    }
    if (maxCol !== k) {
      for (let i = 0; i < m; i++) {
        const t = LU[i][k];
        LU[i][k] = LU[i][maxCol];
        LU[i][maxCol] = t;
      }
      [colPiv[k], colPiv[maxCol]] = [colPiv[maxCol], colPiv[k]];
    }
    rank++;
    const pivot = LU[k][k];
    for (let i = k + 1; i < m; i++) {
      const factor = LU[i][k] / pivot;
      LU[i][k] = factor;
      for (let j = k + 1; j < n; j++) LU[i][j] -= factor * LU[k][j];
    }
  }
  return { LU, rowPiv, colPiv, rank, pivotValues, scale, tolerance };
}

// 利用全主元 LU 求解 A x = b（要求 A 非奇异方阵）。
// PAQ = LU；令 y = Q^T x，则 LU y = Pb，x = Q y。
function luSolve(LU: Matrix, rowPiv: number[], colPiv: number[], b: number[]): number[] {
  const n = LU.length;
  const pb = rowPiv.map((r) => b[r]);
  // Ly = pb
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = pb[i];
    for (let j = 0; j < i; j++) s -= LU[i][j] * y[j];
    y[i] = s;
  }
  // Uz = y，其中 z = Q^T x
  const z = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let j = i + 1; j < n; j++) s -= LU[i][j] * z[j];
    z[i] = s / LU[i][i];
  }
  // x = Q z，即 x[colPiv[k]] = z[k]
  const x = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) x[colPiv[k]] = z[k];
  return x;
}

export interface InverseResult {
  inverse: Matrix | null;
  rank: number;
  singular: boolean;
  pivotValues: number[];
  scale: number;
  tolerance: number;
  residual: number | null; // ||A * A^-1 - I||_max
}

// 对称正定矩阵求逆：列主元 LU + 逐列求解，并以 A*A^-1≈I 独立验证。
export function inverseWithDiag(A: Matrix, relTol = 1e-10): InverseResult {
  const n = A.length;
  const lu = luPartialPivot(A, relTol);
  const singular = lu.rank < n;
  if (singular) {
    return {
      inverse: null,
      rank: lu.rank,
      singular: true,
      pivotValues: lu.pivotValues,
      scale: lu.scale,
      tolerance: lu.tolerance,
      residual: null,
    };
  }
  const inv = zeros(n, n);
  for (let col = 0; col < n; col++) {
    const e = new Array<number>(n).fill(0);
    e[col] = 1;
    const x = luSolve(lu.LU, lu.rowPiv, lu.colPiv, e);
    for (let i = 0; i < n; i++) inv[i][col] = x[i];
  }
  // 独立验证：A * inv 应近似单位矩阵
  const check = multiply(A, inv);
  let residual = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const expected = i === j ? 1 : 0;
      residual = Math.max(residual, Math.abs(check[i][j] - expected));
    }
  }
  return {
    inverse: inv,
    rank: lu.rank,
    singular: false,
    pivotValues: lu.pivotValues,
    scale: lu.scale,
    tolerance: lu.tolerance,
    residual,
  };
}
