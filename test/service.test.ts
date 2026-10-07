import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.js";
import { DopService } from "../src/service.js";
import { ApiError } from "../src/validate.js";
import { createApp } from "../src/api/server.js";
import type { Server } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "gnss-dop-test-"));
let store: Store;
let svc: DopService;

const good = [
  { id: "Z", azDeg: 0, elDeg: 90 },
  { id: "A", azDeg: 0, elDeg: 0 },
  { id: "B", azDeg: 120, elDeg: 0 },
  { id: "C", azDeg: 240, elDeg: 0 },
];

before(() => {
  store = new Store(join(dir, "t.sqlite"));
  svc = new DopService(store);
});

after(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("建星座、导入、计算、幂等命中快照", () => {
  const c = svc.createConstellation("c1");
  svc.importDirections(c.id, good);
  const r1 = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  const r2 = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, true);
  assert.equal(r1.snapshotId, r2.snapshotId);
  assert.equal(r1.result.status, "ok");
});

test("修改观测产生新版本，历史快照仍可核对", () => {
  const c = svc.createConstellation("c2");
  svc.importDirections(c.id, good);
  svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  const v2 = svc.importDirections(c.id, [...good, { id: "X", azDeg: 45, elDeg: 45 }]).version;
  assert.equal(v2, 2);
  const info = svc.describe(c.id);
  assert.equal(info.versions.length, 2);
  const old = svc.matrixSource(c.id, info.snapshots[0]!.id);
  assert.equal(old.snapshot.obsVersion, 1);
  assert.equal(old.sourceObservations.satellites.length, 4);
});

test("计算失败也冻结诊断但不标正常报告", () => {
  const c = svc.createConstellation("c3");
  const bad = [0, 90, 180, 270].map((az, i) => ({ id: `S${i}`, azDeg: az, elDeg: 20 }));
  svc.importDirections(c.id, bad);
  const r = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  assert.equal(r.result.status, "rank_deficient");
  const snaps = svc.describe(c.id).snapshots;
  assert.equal(snaps[snaps.length - 1]!.status, "rank_deficient");
});

test("重启模拟：新 Store 打开同一库，原矩阵与全部候选结果仍在", () => {
  store.db.close();
  const reopened = new Store(join(dir, "t.sqlite"));
  const svc2 = new DopService(reopened);
  const list = svc2.listConstellations();
  assert.ok(list.length >= 3);
  const cid = list.find((c) => c.name === "c1")!.id;
  const src = svc2.matrixSource(cid);
  assert.equal(src.result.status, "ok");
  assert.ok(src.result.H);
  reopened.db.close();
  store = new Store(join(dir, "t.sqlite"));
  svc = new DopService(store);
});

test("批量比较上限", () => {
  assert.throws(
    () => new DopService(store, 3).compareLeaveOneOut(1, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 }),
    /BATCH_LIMIT_EXCEEDED/,
  );
});

test("非法观测整体拒绝：非法仰角、重复 ID、数量不足", () => {
  const c = svc.createConstellation("c4");
  assert.throws(() => svc.importDirections(c.id, good.slice(0, 2)), ApiError);
  assert.throws(
    () => svc.importDirections(c.id, [...good, { id: "Z", azDeg: 1, elDeg: 1 }]),
    (e: unknown) => e instanceof ApiError && e.code === "DUPLICATE_SATELLITE_ID",
  );
  assert.throws(
    () => svc.importDirections(c.id, good.map((s) => ({ ...s, elDeg: s.id === "A" ? 95 : s.elDeg }))),
    (e: unknown) => e instanceof ApiError && e.code === "INVALID_ELEVATION",
  );
  // 整体拒绝：没有任何版本被写入
  assert.throws(
    () => svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 }),
    (e: unknown) => e instanceof ApiError && e.code === "NO_OBSERVATIONS",
  );
});

test("HTTP 端到端：创建/导入/计算/错误码/幂等", async () => {
  const server: Server = createApp(svc);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const h = (path: string, init?: RequestInit) =>
    fetch(base + path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  const created = await h("/api/constellations", { method: "POST", body: JSON.stringify({ name: "http1" }) });
  assert.equal(created.status, 200);
  const id = created.body.data.id;

  const imp = await h(`/api/constellations/${id}/observations`, {
    method: "PUT",
    body: JSON.stringify({ satellites: good }),
  });
  assert.equal(imp.status, 200);

  const c1 = await h(`/api/constellations/${id}/compute`, {
    method: "POST",
    body: JSON.stringify({ cutoffDeg: 0 }),
  });
  const c2 = await h(`/api/constellations/${id}/compute`, {
    method: "POST",
    body: JSON.stringify({ cutoffDeg: 0 }),
  });
  assert.equal(c1.body.data.result.status, "ok");
  assert.equal(c1.body.data.cached, false);
  assert.equal(c2.body.data.cached, true);
  assert.ok(Math.abs(c2.body.data.result.metrics.GDOP - Math.sqrt(3)) < 1e-8);

  const bad = await h(`/api/constellations/${id}/compute`, {
    method: "POST",
    body: JSON.stringify({ cutoffDeg: 120 }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_CUTOFF");

  const nf = await h("/api/constellations/99999/compute", { method: "POST", body: "{}" });
  assert.equal(nf.status, 404);

  const rep = await h(`/api/constellations/${id}/report`);
  assert.equal(rep.body.data.status, "ok");
  assert.ok(rep.body.data.note.includes("无量纲"));

  await new Promise<void>((res) => server.close(() => res()));
});
