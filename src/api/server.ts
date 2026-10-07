import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { ApiError, validateCutoff, validatePositiveTol, validateSatellites } from "../validate.js";
import { DEFAULT_PIVOT_TOL, DEFAULT_RESIDUAL_TOL, type DopService } from "../service.js";

interface Route {
  method: string;
  pattern: RegExp;
  handle: (svc: DopService, params: Record<string, string>, body: unknown, query: URLSearchParams) => unknown | Promise<unknown>;
}

const routes: Route[] = [
  {
    method: "POST",
    pattern: /^\/api\/constellations$/,
    handle: (svc, _p, body) => {
      const name = (body as { name?: unknown })?.name;
      if (typeof name !== "string" || name.trim() === "") throw new ApiError("INVALID_NAME", "name 必须是非空字符串");
      return svc.createConstellation(name.trim());
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/constellations$/,
    handle: (svc) => svc.listConstellations(),
  },
  {
    method: "GET",
    pattern: /^\/api\/constellations\/(\d+)$/,
    handle: (svc, p) => svc.describe(Number(p[0])),
  },
  {
    method: "PUT",
    pattern: /^\/api\/constellations\/(\d+)\/observations$/,
    handle: (svc, p, body) => {
      const sats = validateSatellites((body as { satellites?: unknown })?.satellites ?? body);
      return svc.importDirections(Number(p[0]), sats);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/constellations\/(\d+)\/compute$/,
    handle: (svc, p, body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const version = b.obsVersion === undefined ? undefined : Number(b.obsVersion);
      return svc.compute(
        Number(p[0]),
        {
          cutoffDeg: validateCutoff(b.cutoffDeg),
          pivotTol: validatePositiveTol(b.pivotTol, "pivotTol", DEFAULT_PIVOT_TOL),
          residualTol: validatePositiveTol(b.residualTol, "residualTol", DEFAULT_RESIDUAL_TOL),
        },
        version,
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/constellations\/(\d+)\/compare$/,
    handle: (svc, p, body) => {
      const b = (body ?? {}) as Record<string, unknown>;
      const version = b.obsVersion === undefined ? undefined : Number(b.obsVersion);
      return svc.compareLeaveOneOut(
        Number(p[0]),
        {
          cutoffDeg: validateCutoff(b.cutoffDeg),
          pivotTol: validatePositiveTol(b.pivotTol, "pivotTol", DEFAULT_PIVOT_TOL),
          residualTol: validatePositiveTol(b.residualTol, "residualTol", DEFAULT_RESIDUAL_TOL),
        },
        version,
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/constellations\/(\d+)\/matrix-source(?:\/(\d+))?$/,
    handle: (svc, p, _b, query) =>
      svc.matrixSource(Number(p[0]), p[1] !== undefined ? Number(p[1]) : query.get("snapshotId") ? Number(query.get("snapshotId")) : undefined),
  },
  {
    method: "GET",
    pattern: /^\/api\/constellations\/(\d+)\/report(?:\/(\d+))?$/,
    handle: (svc, p) => {
      const src = svc.matrixSource(Number(p[0]), p[1] !== undefined ? Number(p[1]) : undefined);
      return exportReport(src);
    },
  },
];

export function exportReport(src: ReturnType<DopService["matrixSource"]>) {
  const r = src.result;
  return {
    title: "GNSS 星座几何 DOP 报告（教学用途，单位观测误差下的几何放大，无量纲）",
    snapshot: src.snapshot,
    counts: { observations: r.observationCount, selected: r.selectedCount },
    tolerances: { pivotTol: r.pivotTol, residualTol: r.residualTol, nearZeroNegTol: 1e-10 },
    status: r.status,
    metrics: r.metrics,
    rank: r.rank,
    singularStep: r.singularStep,
    inverseResidual: r.inverseResidual,
    scaleGH: r.scaleGH,
    pivots: r.pivots,
    selection: r.selection,
    satellites: r.satellites.map((s) => ({
      id: s.id,
      raw: { azDeg: s.azDeg, elDeg: s.elDeg },
      normalizedAzDeg: s.azNormDeg,
      ENU: { E: s.E, N: s.N, U: s.U },
      hRow: s.hRow,
    })),
    H: r.H,
    G: r.G,
    Q: r.Q,
    diagnostics: r.diagnostics,
    degeneracy: r.degeneracy,
    note: "DOP 为无量纲几何数，不代表米级定位精度或真实设备误差；等精度、不相关观测假设。",
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new ApiError("BODY_TOO_LARGE", "请求体超过 1MB", 413));
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload, (_k, v) => (typeof v === "number" ? roundNum(v) : v), 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function roundNum(v: number): number {
  if (!Number.isFinite(v)) return v;
  return Math.abs(v) >= 1e-12 ? Number(v.toPrecision(12)) : 0;
}

export function createApp(svc: DopService): Server {
  return createServer(async (req, res) => {
    try {
      if (req.url === "/health" || req.url === "/api/health") return send(res, 200, { status: "ok" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = routes.find(
        (rt) => rt.method === req.method && url.pathname.match(rt.pattern) !== null,
      );
      if (!route) throw new ApiError("NOT_FOUND", `无此路由：${req.method} ${url.pathname}`, 404);
      const match = url.pathname.match(route.pattern)!;
      const params: Record<string, string> = {};
      for (let i = 1; i < match.length; i++) if (match[i] !== undefined) params[i - 1] = match[i]!;
      const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
      const data = await route.handle(svc, params, body, url.searchParams);
      return send(res, 200, { ok: true, data });
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
      console.error(e);
      return send(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: (e as Error).message } });
    }
  });
}

/** 请求系统分配一个空闲 TCP 端口（端口 0），返回真实端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else reject(new Error("无法获取空闲端口"));
    });
    srv.on("error", reject);
  });
}
