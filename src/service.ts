import { computeDop, leaveOneOut, normalizeSatellite, DEFAULT_PIVOT_TOL, DEFAULT_RESIDUAL_TOL, type DopResult, type RawSatellite } from "./math/dop.js";
import { DEFAULT_BATCH_LIMIT, ApiError, validateSatellites } from "./validate.js";
import { Store, DuplicateNameError, hashInput } from "./db/store.js";

export interface ComputeOptions {
  cutoffDeg: number;
  pivotTol: number;
  residualTol: number;
}

export class DopService {
  constructor(
    private store: Store,
    public batchLimit: number = DEFAULT_BATCH_LIMIT,
  ) {}

  createConstellation(name: string) {
    try {
      return this.store.createConstellation(name);
    } catch (e) {
      if (e instanceof DuplicateNameError) throw new ApiError("CONSTELLATION_EXISTS", e.message, 409);
      throw e;
    }
  }

  importDirections(constellationId: number, sats: RawSatellite[]): { version: number } {
    if (!this.store.getConstellation(constellationId))
      throw new ApiError("CONSTELLATION_NOT_FOUND", `星座 ${constellationId} 不存在`, 404);
    sats = validateSatellites(sats);
    const enriched = sats.map((s) => {
      const n = normalizeSatellite(s);
      return { ...s, azNormDeg: n.azNormDeg, E: n.E, N: n.N, U: n.U };
    });
    return { version: this.store.replaceObservations(constellationId, enriched) };
  }

  compute(constellationId: number, opts: ComputeOptions, version?: number) {
    const obs = this.loadObs(constellationId, version);
    const inputHash = hashInput(obs.satellites, opts.cutoffDeg, opts.pivotTol, opts.residualTol);
    const frozen = this.store.findSnapshot(constellationId, obs.version, inputHash);
    if (frozen) {
      return { cached: true, obsVersion: obs.version, snapshotId: frozen.id, result: JSON.parse(frozen.result_json) as DopResult };
    }
    const result = computeDop(obs.satellites, opts.cutoffDeg, opts.pivotTol, opts.residualTol);
    const snap = this.store.saveSnapshot(
      constellationId,
      obs.version,
      opts.cutoffDeg,
      opts.pivotTol,
      opts.residualTol,
      result.status,
      inputHash,
      result,
    );
    return { cached: false, obsVersion: obs.version, snapshotId: snap.id, result };
  }

  compareLeaveOneOut(constellationId: number, opts: ComputeOptions, version?: number) {
    const obs = this.loadObs(constellationId, version);
    const comparisons = leaveOneOut(
      obs.satellites,
      opts.cutoffDeg,
      opts.pivotTol,
      opts.residualTol,
      this.batchLimit,
    );
    return { obsVersion: obs.version, baseCount: obs.satellites.length, comparisons };
  }

  matrixSource(constellationId: number, snapshotId?: number) {
    if (!this.store.getConstellation(constellationId))
      throw new ApiError("CONSTELLATION_NOT_FOUND", `星座 ${constellationId} 不存在`, 404);
    const snaps = this.store.listSnapshots(constellationId);
    const chosen = snapshotId !== undefined ? snaps.find((s) => s.id === snapshotId) : snaps[snaps.length - 1];
    if (!chosen) throw new ApiError("SNAPSHOT_NOT_FOUND", "尚无冻结计算结果，请先计算", 404);
    const obs = this.store.getObservations(constellationId, chosen.obs_version);
    return {
      snapshot: {
        id: chosen.id,
        obsVersion: chosen.obs_version,
        cutoffDeg: chosen.cutoff_deg,
        pivotTol: chosen.pivot_tol,
        residualTol: chosen.residual_tol,
        status: chosen.status,
        inputHash: chosen.input_hash,
        createdAt: chosen.created_at,
      },
      sourceObservations: obs,
      result: JSON.parse(chosen.result_json) as DopResult,
    };
  }

  listConstellations() {
    return this.store.listConstellations();
  }

  describe(constellationId: number) {
    if (!this.store.getConstellation(constellationId))
      throw new ApiError("CONSTELLATION_NOT_FOUND", `星座 ${constellationId} 不存在`, 404);
    return {
      constellation: this.store.getConstellation(constellationId),
      versions: this.store.listVersions(constellationId),
      snapshots: this.store.listSnapshots(constellationId).map((s) => ({
        id: s.id,
        obsVersion: s.obs_version,
        cutoffDeg: s.cutoff_deg,
        status: s.status,
        createdAt: s.created_at,
      })),
    };
  }

  private loadObs(constellationId: number, version?: number) {
    if (!this.store.getConstellation(constellationId))
      throw new ApiError("CONSTELLATION_NOT_FOUND", `星座 ${constellationId} 不存在`, 404);
    const obs = this.store.getObservations(constellationId, version);
    if (obs.satellites.length === 0)
      throw new ApiError("NO_OBSERVATIONS", "星座尚未导入方向表", 409);
    return obs;
  }
}

export { DEFAULT_PIVOT_TOL, DEFAULT_RESIDUAL_TOL };
