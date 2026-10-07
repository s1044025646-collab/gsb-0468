/**
 * SQLite 持久层（使用 Node 内置 node:sqlite，无需原生编译）。
 * 保存：星座、原始观测、观测版本、计算快照（含失败诊断）。
 * 修改观测或门槛产生新版本；计算失败可保存诊断但不标为正常精度报告。
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DopResult } from "../math/dop.js";
import type { RawSatellite } from "../math/dop.js";

export interface ConstellationRow {
  id: number;
  name: string;
  created_at: string;
}

export interface SnapshotRow {
  id: number;
  constellation_id: number;
  obs_version: number;
  cutoff_deg: number;
  pivot_tol: number;
  residual_tol: number;
  status: string;
  input_hash: string;
  result_json: string;
  created_at: string;
}

export function hashInput(sats: RawSatellite[], cutoff: number, pivotTol: number, residualTol: number): string {
  const canonical = JSON.stringify({
    s: sats.map((s) => [s.id, s.azDeg, s.elDeg]),
    c: cutoff,
    p: pivotTol,
    r: residualTol,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS constellations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS observation_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        constellation_id INTEGER NOT NULL REFERENCES constellations(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(constellation_id, version)
      );
      CREATE TABLE IF NOT EXISTS satellites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES observation_versions(id) ON DELETE CASCADE,
        sat_uid TEXT NOT NULL,
        az_deg REAL NOT NULL,
        el_deg REAL NOT NULL,
        az_norm_deg REAL NOT NULL,
        e REAL NOT NULL, n REAL NOT NULL, u REAL NOT NULL,
        UNIQUE(version_id, sat_uid)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        constellation_id INTEGER NOT NULL REFERENCES constellations(id) ON DELETE CASCADE,
        obs_version INTEGER NOT NULL,
        cutoff_deg REAL NOT NULL,
        pivot_tol REAL NOT NULL,
        residual_tol REAL NOT NULL,
        status TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(constellation_id, obs_version, input_hash)
      );
    `);
  }

  createConstellation(name: string): ConstellationRow {
    try {
      const r = this.db.prepare("INSERT INTO constellations(name) VALUES (?)").run(name);
      const id = Number(r.lastInsertRowid);
      this.db
        .prepare("INSERT INTO observation_versions(constellation_id, version) VALUES (?, 1)")
        .run(id);
      return this.getConstellation(id)!;
    } catch (e) {
      if ((e as Error).message.includes("UNIQUE")) throw new DuplicateNameError(name);
      throw e;
    }
  }

  getConstellation(id: number): ConstellationRow | null {
    return (this.db.prepare("SELECT * FROM constellations WHERE id = ?").get(id) as ConstellationRow | undefined) ?? null;
  }

  listConstellations(): ConstellationRow[] {
    return this.db.prepare("SELECT * FROM constellations ORDER BY id").all() as unknown as ConstellationRow[];
  }

  currentVersion(constellationId: number): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM observation_versions WHERE constellation_id = ?")
      .get(constellationId) as { v: number | null };
    if (row.v === null) throw new Error("星座不存在");
    return row.v;
  }

  private versionId(constellationId: number, version: number): number {
    const row = this.db
      .prepare("SELECT id FROM observation_versions WHERE constellation_id = ? AND version = ?")
      .get(constellationId, version) as { id: number } | undefined;
    if (!row) throw new Error("版本不存在");
    return row.id;
  }

  /** 写入观测：若当前最新版本为空则就地填充，否则整体替换为新版本。 */
  replaceObservations(
    constellationId: number,
    sats: (RawSatellite & { azNormDeg: number; E: number; N: number; U: number })[],
  ): number {
    const current = this.currentVersion(constellationId);
    const currentVid = this.versionId(constellationId, current);
    const cnt = (
      this.db.prepare("SELECT COUNT(*) AS c FROM satellites WHERE version_id = ?").get(currentVid) as { c: number }
    ).c;
    const next = cnt === 0 ? current : current + 1;
    const versionId =
      cnt === 0
        ? currentVid
        : Number(
            this.db
              .prepare("INSERT INTO observation_versions(constellation_id, version) VALUES (?, ?)")
              .run(constellationId, next).lastInsertRowid,
          );
    const stmt = this.db.prepare(
      "INSERT INTO satellites(version_id, sat_uid, az_deg, el_deg, az_norm_deg, e, n, u) VALUES (?,?,?,?,?,?,?,?)",
    );
    for (const s of sats) stmt.run(versionId, s.id, s.azDeg, s.elDeg, s.azNormDeg, s.E, s.N, s.U);
    return next;
  }

  getObservations(constellationId: number, version?: number): { version: number; satellites: RawSatellite[] } {
    const v = version ?? this.currentVersion(constellationId);
    const versionId = this.versionId(constellationId, v);
    const rows = this.db
      .prepare("SELECT sat_uid, az_deg, el_deg FROM satellites WHERE version_id = ? ORDER BY id")
      .all(versionId) as { sat_uid: string; az_deg: number; el_deg: number }[];
    return {
      version: v,
      satellites: rows.map((r) => ({ id: r.sat_uid, azDeg: r.az_deg, elDeg: r.el_deg })),
    };
  }

  listVersions(constellationId: number): { version: number; created_at: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT ov.version, ov.created_at, COUNT(s.id) AS count
         FROM observation_versions ov LEFT JOIN satellites s ON s.version_id = ov.id
         WHERE ov.constellation_id = ? GROUP BY ov.id ORDER BY ov.version`,
      )
      .all(constellationId) as { version: number; created_at: string; count: number }[];
  }

  /** 幂等：相同输入哈希已冻结则直接返回旧快照。 */
  findSnapshot(
    constellationId: number,
    obsVersion: number,
    inputHash: string,
  ): SnapshotRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM snapshots WHERE constellation_id = ? AND obs_version = ? AND input_hash = ?")
        .get(constellationId, obsVersion, inputHash) as SnapshotRow | undefined) ?? null
    );
  }

  saveSnapshot(
    constellationId: number,
    obsVersion: number,
    cutoff: number,
    pivotTol: number,
    residualTol: number,
    status: string,
    inputHash: string,
    result: DopResult,
  ): SnapshotRow {
    this.db
      .prepare(
        `INSERT INTO snapshots(constellation_id, obs_version, cutoff_deg, pivot_tol, residual_tol, status, input_hash, result_json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(constellation_id, obs_version, input_hash) DO NOTHING`,
      )
      .run(
        constellationId,
        obsVersion,
        cutoff,
        pivotTol,
        residualTol,
        status,
        inputHash,
        JSON.stringify(result),
      );
    return this.findSnapshot(constellationId, obsVersion, inputHash)!;
  }

  listSnapshots(constellationId: number): SnapshotRow[] {
    return this.db
      .prepare("SELECT * FROM snapshots WHERE constellation_id = ? ORDER BY id")
      .all(constellationId) as unknown as SnapshotRow[];
  }
}

export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(`星座名称已存在：${name}`);
    this.name = name;
  }
}
