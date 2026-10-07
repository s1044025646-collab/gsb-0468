import type { RawSatellite } from "./math/dop.js";

export const MIN_SATS = 4;
export const MAX_SATS = 64;
export const DEFAULT_BATCH_LIMIT = 64;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 非法观测整体拒绝：任一卫星不合法都抛出，绝不部分入库。 */
export function validateSatellites(input: unknown): RawSatellite[] {
  if (!Array.isArray(input)) throw new ApiError("INVALID_BODY", "观测必须是数组", 400);
  if (input.length < MIN_SATS)
    throw new ApiError("TOO_FEW_SATELLITES", `至少需要 ${MIN_SATS} 颗卫星，收到 ${input.length} 颗`, 400);
  if (input.length > MAX_SATS)
    throw new ApiError("TOO_MANY_SATELLITES", `卫星数量上限 ${MAX_SATS}，收到 ${input.length} 颗`, 400);

  const ids = new Set<string>();
  return input.map((item, idx) => {
    const where = `第 ${idx + 1} 条观测`;
    if (typeof item !== "object" || item === null)
      throw new ApiError("INVALID_SATELLITE", `${where} 不是对象`);
    const { id, azDeg, elDeg } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "")
      throw new ApiError("INVALID_SATELLITE_ID", `${where} 的 id 必须是非空字符串`);
    if (ids.has(id)) throw new ApiError("DUPLICATE_SATELLITE_ID", `卫星 ID 重复：${id}`);
    ids.add(id);
    if (!isFiniteNumber(azDeg))
      throw new ApiError("INVALID_AZIMUTH", `${where}（${id}）方位角必须是有限数（度）`);
    if (!isFiniteNumber(elDeg) || elDeg < 0 || elDeg > 90)
      throw new ApiError("INVALID_ELEVATION", `${where}（${id}）仰角必须是 0 到 90 度之间的有限数`);
    return { id, azDeg, elDeg };
  });
}

export function validateCutoff(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (!isFiniteNumber(v) || v < 0 || v > 90)
    throw new ApiError("INVALID_CUTOFF", "仰角截止值必须是 0 到 90 度之间的有限数");
  return v;
}

export function validatePositiveTol(v: unknown, name: string, def: number): number {
  if (v === undefined || v === null) return def;
  if (!isFiniteNumber(v) || v <= 0 || v >= 1)
    throw new ApiError("INVALID_TOLERANCE", `${name} 必须是 (0,1) 区间内的有限数`);
  return v;
}
