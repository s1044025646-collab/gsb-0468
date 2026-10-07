/**
 * 一键演示：使用临时数据目录，建立手算夹具星座、退化星座、加入异仰角星座，
 * 演示计算、截止门槛、幂等、逐星移除与导出报告。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../db/store.js";
import { DopService } from "../service.js";
import { exportReport } from "../api/server.js";

const dir = mkdtempSync(join(tmpdir(), "gnss-dop-demo-"));
process.env.DOP_DATA_DIR = dir;
const store = new Store(join(dir, "dop.sqlite"));
const svc = new DopService(store);

const fixture = [
  { id: "ZENITH", azDeg: 0, elDeg: 90 },
  { id: "H0", azDeg: 0, elDeg: 0 },
  { id: "H120", azDeg: 120, elDeg: 0 },
  { id: "H240", azDeg: 240, elDeg: 0 },
];

const degenerateSameEl = [
  { id: "A", azDeg: 0, elDeg: 30 },
  { id: "B", azDeg: 90, elDeg: 30 },
  { id: "C", azDeg: 180, elDeg: 30 },
  { id: "D", azDeg: 270, elDeg: 30 },
];

const enriched = [
  ...degenerateSameEl,
  { id: "HI", azDeg: 45, elDeg: 75 },
];

function run(title: string, fn: () => void): void {
  console.log("\n================ " + title + " ================");
  fn();
}

run("1. 手算夹具：1 天顶 + 3 颗零仰角（0/120/240）", () => {
  const c = svc.createConstellation("fixture");
  svc.importDirections(c.id, fixture);
  const r1 = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  const r2 = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  console.log("status:", r1.result.status, "| GDOP:", r1.result.metrics?.GDOP, "| HDOP:", r1.result.metrics?.HDOP, "| VDOP:", r1.result.metrics?.VDOP);
  console.log("Q 对角:", r1.result.Q?.map((row, i) => row[i]));
  console.log("GQ-I 最大残差:", r1.result.inverseResidual, "| 秩:", r1.result.rank);
  console.log("重复请求命中冻结快照(幂等):", r2.cached, "snapshotId:", r1.snapshotId, "==", r2.snapshotId);
});

run("2. 退化：四颗星仰角全部相同（30°），天向列与钟差列相关", () => {
  const c = svc.createConstellation("degenerate");
  svc.importDirections(c.id, degenerateSameEl);
  const r = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  console.log("status:", r.result.status, "| 秩:", r.result.rank, "| 奇异主元步:", r.result.singularStep);
  console.log("退化说明:", r.result.degeneracy);
});

run("3. 加入一颗高仰角异方向星后恢复可解", () => {
  const c = svc.createConstellation("enriched");
  svc.importDirections(c.id, enriched);
  const r = svc.compute(c.id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  console.log("status:", r.result.status, "| GDOP:", r.result.metrics?.GDOP);
});

run("4. 仰角截止恰等值保留（cutoff=0 保留 H0）与逐星移除", () => {
  const id = svc.listConstellations().find((c) => c.name === "fixture")!.id;
  const cmp = svc.compareLeaveOneOut(id, { cutoffDeg: 0, pivotTol: 1e-10, residualTol: 1e-8 });
  for (const x of cmp.comparisons)
    console.log(`移除 ${x.removedId}: status=${x.result.status}, 入选=${x.result.selectedCount}, GDOP=${x.result.metrics?.GDOP ?? "N/A"}`);
});

run("5. 导出完整报告（节选）", () => {
  const id = svc.listConstellations().find((c) => c.name === "fixture")!.id;
  const report = exportReport(svc.matrixSource(id));
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log("报告已写入:", path);
  console.log("入选/排除:", report.selection.map((s) => `${s.id}:${s.included ? "入选" : "排除"}`).join(", "));
});

console.log("\n演示完成，临时数据目录:", dir);
