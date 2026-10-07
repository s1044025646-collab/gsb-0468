#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../db/store.js";
import { DopService } from "../service.js";
import { validateSatellites, validateCutoff, validatePositiveTol } from "../validate.js";
import { DEFAULT_PIVOT_TOL, DEFAULT_RESIDUAL_TOL } from "../math/dop.js";
import { exportReport } from "../api/server.js";

const dataDir = process.env.DOP_DATA_DIR ? resolve(process.env.DOP_DATA_DIR) : resolve("data");
const store = new Store(resolve(dataDir, "dop.sqlite"));
const svc = new DopService(store);

function usage(): never {
  console.error(`
用法:
  npm run cli -- create <名称>
  npm run cli -- list
  npm run cli -- import <星座ID> <观测JSON文件>
  npm run cli -- compute <星座ID> [--cutoff 度] [--pivot-tol t] [--residual-tol t] [--obs-version v]
  npm run cli -- compare <星座ID> [--cutoff 度] [...]
  npm run cli -- matrix-source <星座ID> [--snapshot id]
  npm run cli -- report <星座ID> [--snapshot id]

观测 JSON 文件格式:
  { "satellites": [ { "id": "S1", "azDeg": 0, "elDeg": 0 }, ... ] }
  数量限制 4..64，ID 唯一，仰角 0..90。
`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) usage();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function opts(args: string[]) {
  return {
    cutoffDeg: validateCutoff(flag(args, "--cutoff") === undefined ? undefined : Number(flag(args, "--cutoff"))),
    pivotTol: validatePositiveTol(flag(args, "--pivot-tol") === undefined ? undefined : Number(flag(args, "--pivot-tol")), "pivotTol", DEFAULT_PIVOT_TOL),
    residualTol: validatePositiveTol(flag(args, "--residual-tol") === undefined ? undefined : Number(flag(args, "--residual-tol")), "residualTol", DEFAULT_RESIDUAL_TOL),
  };
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, (_k, v) => (typeof v === "number" ? Number(v.toPrecision(10)) : v), 2));
}

try {
  switch (cmd) {
    case "create":
      print(svc.createConstellation(rest[0] ?? usage()));
      break;
    case "list":
      print(svc.listConstellations());
      break;
    case "import": {
      const id = Number(rest[0]);
      const file = rest[1] ?? usage();
      const parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
      const sats = validateSatellites(parsed.satellites ?? parsed);
      print(svc.importDirections(id, sats));
      break;
    }
    case "compute": {
      const id = Number(rest[0]);
      const v = flag(rest, "--obs-version");
      print(svc.compute(id, opts(rest), v === undefined ? undefined : Number(v)));
      break;
    }
    case "compare": {
      const id = Number(rest[0]);
      const v = flag(rest, "--obs-version");
      print(svc.compareLeaveOneOut(id, opts(rest), v === undefined ? undefined : Number(v)));
      break;
    }
    case "matrix-source": {
      const id = Number(rest[0]);
      const s = flag(rest, "--snapshot");
      print(svc.matrixSource(id, s === undefined ? undefined : Number(s)));
      break;
    }
    case "report": {
      const id = Number(rest[0]);
      const s = flag(rest, "--snapshot");
      print(exportReport(svc.matrixSource(id, s === undefined ? undefined : Number(s))));
      break;
    }
    default:
      usage();
  }
} catch (e) {
  console.error("错误:", (e as Error).message);
  process.exit(1);
}
