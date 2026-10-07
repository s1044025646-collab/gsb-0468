import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ComputeResult, SatInput } from './dop.js';
import { DEFAULT_REL_TOL } from './dop.js';

export interface ConstellationRow {
  id: number;
  name: string;
  version: number;
  created_at: string;
}

export interface ReportRow {
  id: number;
  constellation_id: number;
  version: number;
  cutoff_deg: number;
  rel_tolerance: number;
  status: string;
  reason: string | null;
  is_normal_precision: number;
  result_json: string;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS constellations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        constellation_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        sat_id TEXT NOT NULL,
        azimuth_deg REAL NOT NULL,
        elevation_deg REAL NOT NULL,
        ord INTEGER NOT NULL,
        FOREIGN KEY (constellation_id) REFERENCES constellations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS selection_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        constellation_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        cutoff_deg REAL NOT NULL,
        rel_tolerance REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        constellation_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        cutoff_deg REAL NOT NULL,
        rel_tolerance REAL NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        is_normal_precision INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (constellation_id, version, cutoff_deg, rel_tolerance)
      );
      CREATE INDEX IF NOT EXISTS idx_obs ON observations(constellation_id, version);
    `);
  }

  createConstellation(name: string): ConstellationRow {
    const info = this.db
      .prepare('INSERT INTO constellations (name) VALUES (?)')
      .run(name);
    return this.getConstellation(Number(info.lastInsertRowid))!;
  }

  getConstellation(id: number): ConstellationRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM constellations WHERE id = ?')
        .get(id) as ConstellationRow | undefined) ?? null
    );
  }

  // 导入（或覆盖）方向表会产生新版本。
  importObservations(
    constellationId: number,
    sats: SatInput[],
  ): number {
    const c = this.getConstellation(constellationId);
    if (!c) throw new Error('星座不存在');
    const newVersion = c.version + 1;
    const insert = this.db.prepare(
      `INSERT INTO observations (constellation_id, version, sat_id, azimuth_deg, elevation_deg, ord)
       VALUES (?,?,?,?,?,?)`,
    );
    const tx = this.db;
    tx.exec('BEGIN');
    try {
      sats.forEach((s, i) =>
        insert.run(
          constellationId,
          newVersion,
          s.id,
          s.azimuthDeg,
          s.elevationDeg,
          i,
        ),
      );
      this.db
        .prepare('UPDATE constellations SET version = ? WHERE id = ?')
        .run(newVersion, constellationId);
      tx.exec('COMMIT');
    } catch (e) {
      tx.exec('ROLLBACK');
      throw e;
    }
    return newVersion;
  }

  getObservations(constellationId: number, version?: number): SatInput[] {
    const c = this.getConstellation(constellationId);
    if (!c) throw new Error('星座不存在');
    const v = version ?? c.version;
    const rows = this.db
      .prepare(
        `SELECT sat_id, azimuth_deg, elevation_deg FROM observations
         WHERE constellation_id = ? AND version = ? ORDER BY ord`,
      )
      .all(constellationId, v) as Array<{
      sat_id: string;
      azimuth_deg: number;
      elevation_deg: number;
    }>;
    return rows.map((r) => ({
      id: r.sat_id,
      azimuthDeg: r.azimuth_deg,
      elevationDeg: r.elevation_deg,
    }));
  }

  listVersions(constellationId: number): number[] {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT version FROM observations WHERE constellation_id = ? ORDER BY version',
      )
      .all(constellationId) as Array<{ version: number }>;
    return rows.map((r) => r.version);
  }

  // 幂等冻结结果：相同（星座,版本,门槛,容差）返回既有报告。
  upsertReport(
    constellationId: number,
    version: number,
    cutoffDeg: number,
    relTolerance: number,
    result: ComputeResult,
  ): { report: ReportRow; created: boolean } {
    const existing = this.getReport(constellationId, version, cutoffDeg, relTolerance);
    if (existing) return { report: existing, created: false };
    const isNormal = result.status === 'OK' ? 1 : 0;
    const info = this.db
      .prepare(
        `INSERT INTO reports
          (constellation_id, version, cutoff_deg, rel_tolerance, status, reason, is_normal_precision, result_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        constellationId,
        version,
        cutoffDeg,
        relTolerance,
        result.status,
        result.reason ?? null,
        isNormal,
        JSON.stringify(result),
      );
    return {
      report: this.getReportById(Number(info.lastInsertRowid))!,
      created: true,
    };
  }

  getReport(
    constellationId: number,
    version: number,
    cutoffDeg: number,
    relTolerance: number = DEFAULT_REL_TOL,
  ): ReportRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM reports WHERE constellation_id = ? AND version = ?
           AND cutoff_deg = ? AND rel_tolerance = ?`,
        )
        .get(constellationId, version, cutoffDeg, relTolerance) as
        | ReportRow
        | undefined) ?? null
    );
  }

  getReportById(id: number): ReportRow | null {
    return (
      (this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as
        | ReportRow
        | undefined) ?? null
    );
  }

  listReports(constellationId: number): ReportRow[] {
    return this.db
      .prepare(
        'SELECT * FROM reports WHERE constellation_id = ? ORDER BY id',
      )
      .all(constellationId) as unknown as ReportRow[];
  }

  close(): void {
    this.db.close();
  }
}
