import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Store } from './store.js';
import { AppError } from './errors.js';
import {
  computeDOP,
  leaveOneOut,
  validateSatellites,
  DEFAULT_REL_TOL,
  type SatInput,
  type ComputeResult,
} from './dop.js';

export interface AppContext {
  store: Store;
}

function send(res: any, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new AppError('INVALID_PARAMS', '请求体超过 4MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new AppError('INVALID_PARAMS', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    ctx: AppContext,
    req: IncomingMessage,
    body: any,
    params: string[],
    query: URLSearchParams,
  ) => Promise<any> | any;
}

const routes: Route[] = [
  {
    method: 'POST',
    pattern: /^\/api\/constellations$/,
    handler: (ctx, _req, body) => {
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name : '未命名星座';
      const c = ctx.store.createConstellation(name);
      // 可选：建星座时直接导入
      if (Array.isArray(body?.satellites)) {
        validateSatellites(body.satellites);
        const version = ctx.store.importObservations(c.id, body.satellites);
        return { constellation: c, version, satellites: body.satellites };
      }
      return { constellation: c };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/constellations\/(\d+)$/,
    handler: (ctx, _r, _b, p) => {
      const c = ctx.store.getConstellation(Number(p[0]));
      if (!c) throw new AppError('NOT_FOUND', '星座不存在');
      return {
        constellation: c,
        versions: ctx.store.listVersions(c.id),
        observations: ctx.store.getObservations(c.id),
      };
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/constellations\/(\d+)\/observations$/,
    handler: (ctx, _r, body, p) => {
      const id = Number(p[0]);
      if (!ctx.store.getConstellation(id)) throw new AppError('NOT_FOUND', '星座不存在');
      const sats: SatInput[] = body?.satellites;
      validateSatellites(sats); // 非法整体拒绝
      const version = ctx.store.importObservations(id, sats);
      return { version, satellites: sats };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/constellations\/(\d+)\/observations$/,
    handler: (ctx, _r, _b, p, q) => {
      const id = Number(p[0]);
      const version = q.get('version') ? Number(q.get('version')) : undefined;
      if (!ctx.store.getConstellation(id)) throw new AppError('NOT_FOUND', '星座不存在');
      return { version: version ?? ctx.store.getConstellation(id)!.version, observations: ctx.store.getObservations(id, version) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/constellations\/(\d+)\/compute$/,
    handler: (ctx, _r, body, p) => {
      const id = Number(p[0]);
      const c = ctx.store.getConstellation(id);
      if (!c) throw new AppError('NOT_FOUND', '星座不存在');
      const cutoff = typeof body?.cutoffDeg === 'number' ? body.cutoffDeg : 0;
      const relTol =
        typeof body?.relTolerance === 'number' ? body.relTolerance : DEFAULT_REL_TOL;
      const sats = ctx.store.getObservations(id);
      validateSatellites(sats);
      const result: ComputeResult = computeDOP(sats, cutoff, relTol);
      const { report, created } = ctx.store.upsertReport(
        id,
        c.version,
        cutoff,
        relTol,
        result,
      );
      return {
        reportId: report.id,
        cached: !created,
        isNormalPrecision: report.is_normal_precision === 1,
        result,
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/constellations\/(\d+)\/leave-one-out$/,
    handler: (ctx, _r, body, p) => {
      const id = Number(p[0]);
      if (!ctx.store.getConstellation(id)) throw new AppError('NOT_FOUND', '星座不存在');
      const cutoff = typeof body?.cutoffDeg === 'number' ? body.cutoffDeg : 0;
      const relTol =
        typeof body?.relTolerance === 'number' ? body.relTolerance : DEFAULT_REL_TOL;
      const sats = ctx.store.getObservations(id);
      validateSatellites(sats);
      const entries = leaveOneOut(sats, cutoff, relTol);
      return {
        cutoffDeg: cutoff,
        relTolerance: relTol,
        comparisons: entries.map((e) => ({
          removedId: e.removedId,
          status: e.result.status,
          reason: e.result.reason ?? null,
          selectedCount: e.result.selectedCount,
          metrics: e.result.metrics,
        })),
        results: entries.map((e) => e.result),
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/constellations\/(\d+)\/reports$/,
    handler: (ctx, _r, _b, p) => {
      const id = Number(p[0]);
      if (!ctx.store.getConstellation(id)) throw new AppError('NOT_FOUND', '星座不存在');
      const reports = ctx.store.listReports(id).map((r) => ({
        id: r.id,
        version: r.version,
        cutoffDeg: r.cutoff_deg,
        relTolerance: r.rel_tolerance,
        status: r.status,
        reason: r.reason,
        isNormalPrecision: r.is_normal_precision === 1,
        createdAt: r.created_at,
      }));
      return { reports };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/(\d+)$/,
    handler: (ctx, _r, _b, p) => {
      const r = ctx.store.getReportById(Number(p[0]));
      if (!r) throw new AppError('NOT_FOUND', '报告不存在');
      return {
        id: r.id,
        constellationId: r.constellation_id,
        version: r.version,
        cutoffDeg: r.cutoff_deg,
        relTolerance: r.rel_tolerance,
        status: r.status,
        reason: r.reason,
        isNormalPrecision: r.is_normal_precision === 1,
        createdAt: r.created_at,
        result: JSON.parse(r.result_json),
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: () => ({ status: 'ok' }),
  },
];

export function createApp(store: Store): Server {
  const ctx: AppContext = { store };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost');
      const path = url.pathname;
      if (path === '/') {
        return send(res, 200, {
          service: 'gnss-dop',
          endpoints: routes.map((r) => `${r.method} ${r.pattern.source.replace(/\[\^/g, '{').replace(/\\\//g, '/').replace(/\$\//g, '')}`),
        });
      }
      for (const route of routes) {
        const m = path.match(route.pattern);
        if (m && route.method === req.method) {
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method!) ? await readBody(req) : {};
          const result = await route.handler(ctx, req, body, m.slice(1), url.searchParams);
          return send(res, 200, result);
        }
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${req.method} ${path}` } });
    } catch (e) {
      if (e instanceof AppError) {
        const http =
          e.code === 'NOT_FOUND'
            ? 404
            : e.code === 'VERSION_CONFLICT'
              ? 409
              : 400;
        return send(res, http, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      }
      const msg = e instanceof Error ? e.message : String(e);
      send(res, 500, { error: { code: 'INTERNAL', message: msg } });
    }
  });
}

// 请求系统分配空闲端口（端口 0）。
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('无法获取空闲端口'));
      }
    });
  });
}

export async function startServer(
  dbPath: string,
  requestedPort?: number,
): Promise<{ server: Server; port: number; store: Store }> {
  const store = new Store(dbPath);
  const server = createApp(store);
  const port = requestedPort ?? (await pickFreePort());
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, store };
}
