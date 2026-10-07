#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from '../store.js';
import { AppError } from '../errors.js';
import {
  computeDOP,
  leaveOneOut,
  validateSatellites,
  DEFAULT_REL_TOL,
  type SatInput,
} from '../dop.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const command = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { command, flags, positional };
}

function loadSats(flags: Record<string, string>): SatInput[] {
  let raw: unknown;
  if (flags.file) {
    raw = JSON.parse(readFileSync(resolve(flags.file), 'utf-8'));
  } else if (flags.json) {
    raw = JSON.parse(flags.json);
  } else {
    raw = JSON.parse(readFileSync(0, 'utf-8'));
  }
  const arr: SatInput[] = Array.isArray(raw)
    ? raw
    : (raw as { satellites?: SatInput[] }).satellites ?? [];
  if (!Array.isArray(arr)) {
    throw new AppError('INVALID_PARAMS', '需要卫星数组，或含 satellites 字段的对象');
  }
  return arr;
}

function printCompute(result: ReturnType<typeof computeDOP>): void {
  console.log('状态:', result.status);
  if (result.reason) console.log('原因:', result.reason);
  console.log(
    `入选 ${result.selectedCount} 颗 / 排除 ${result.excludedCount} 颗（截止 ${result.cutoffDeg}°）`,
  );
  if (result.pivot) {
    console.log(
      `秩: ${result.rank}，主元绝对值: [${result.pivot.values
        .map((v) => v.toExponential(3))
        .join(', ')}]`,
    );
    console.log(
      `尺度: ${result.pivot.scale.toExponential(3)}，相对容差: ${result.pivot.relTolerance}，绝对容差: ${result.pivot.absTolerance.toExponential(3)}`,
    );
  }
  if (result.residual !== null) {
    console.log('||HtH·Q - I||_max 残差:', result.residual.toExponential(3));
  }
  if (result.nearZeroFixes) console.log('近零负对角修正数:', result.nearZeroFixes);
  if (result.metrics) {
    const m = result.metrics;
    console.log('--- DOP（无量纲几何放大因子）---');
    console.log('HDOP:', m.HDOP.toFixed(6));
    console.log('VDOP:', m.VDOP.toFixed(6));
    console.log('PDOP:', m.PDOP.toFixed(6));
    console.log('TDOP:', m.TDOP.toFixed(6));
    console.log('GDOP:', m.GDOP.toFixed(6));
  }
  console.log('--- 每颗卫星 ---');
  for (const s of result.satellites) {
    console.log(
      `${s.selected ? '✓' : '✗'} ${s.id}  az=${s.azimuthRaw}°→${s.azimuthNormalized.toFixed(3)}° el=${s.elevation}°  ` +
        `E=${s.E.toFixed(4)} N=${s.N.toFixed(4)} U=${s.U.toFixed(4)} H=[${s.rowH
          .map((x) => x.toFixed(4))
          .join(', ')}]` +
        (s.excludeReason ? `  排除: ${s.excludeReason}` : ''),
    );
  }
  if (result.HtH && result.Q) {
    console.log('H^T H =', JSON.stringify(result.HtH));
    console.log('Q     =', JSON.stringify(result.Q));
  }
}

function usage(): void {
  console.log(`GNSS DOP 教学分析 CLI

用法:
  node dist/bin/cli.js compute [--file sats.json | --json '<...>'] [--cutoff 度数] [--tol 相对容差]
  node dist/bin/cli.js leave-one-out [--file sats.json] [--cutoff 度数]
  node dist/bin/cli.js init-db [--db data/gnss.db]
  node dist/bin/cli.js create --name 名称 [--file sats.json] [--db data/gnss.db]
  node dist/bin/cli.js report --id 星座ID [--version N] [--cutoff 度数] [--db ...] [--export out.json]
  node dist/bin/cli.js help

输入 JSON 为 [{"id":"S1","azimuthDeg":0,"elevationDeg":90}, ...]
`);
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dbPath = resolve(flags.db ?? 'data/gnss.db');

  switch (command) {
    case 'compute': {
      const sats = loadSats(flags);
      validateSatellites(sats);
      const result = computeDOP(
        sats,
        Number(flags.cutoff ?? 0),
        Number(flags.tol ?? DEFAULT_REL_TOL),
      );
      printCompute(result);
      break;
    }
    case 'leave-one-out': {
      const sats = loadSats(flags);
      validateSatellites(sats);
      const entries = leaveOneOut(sats, Number(flags.cutoff ?? 0));
      for (const e of entries) {
        const m = e.result.metrics;
        console.log(
          `移除 ${e.removedId}: ${e.result.status}` +
            (e.result.reason ? `（${e.result.reason}）` : '') +
            (m ? ` GDOP=${m.GDOP.toFixed(4)} HDOP=${m.HDOP.toFixed(4)} VDOP=${m.VDOP.toFixed(4)}` : ''),
        );
      }
      break;
    }
    case 'init-db': {
      const store = new Store(dbPath);
      store.close();
      console.log('数据库已初始化:', dbPath);
      break;
    }
    case 'create': {
      const store = new Store(dbPath);
      const c = store.createConstellation(flags.name ?? '未命名星座');
      if (flags.file || flags.json) {
        const sats = loadSats(flags);
        validateSatellites(sats);
        const version = store.importObservations(c.id, sats);
        console.log(`已创建星座 id=${c.id}，导入 ${sats.length} 颗，版本=${version}`);
      } else {
        console.log(`已创建空星座 id=${c.id}`);
      }
      store.close();
      break;
    }
    case 'report': {
      const store = new Store(dbPath);
      const id = Number(flags.id);
      const c = store.getConstellation(id);
      if (!c) throw new AppError('NOT_FOUND', '星座不存在');
      const version = Number(flags.version ?? c.version);
      const sats = store.getObservations(id, version);
      validateSatellites(sats);
      const cutoff = Number(flags.cutoff ?? 0);
      const tol = Number(flags.tol ?? DEFAULT_REL_TOL);
      const result = computeDOP(sats, cutoff, tol);
      const { report, created } = store.upsertReport(id, version, cutoff, tol, result);
      console.log(created ? '已冻结新报告' : '命中既有冻结报告（幂等）', `reportId=${report.id}`);
      printCompute(result);
      if (flags.export) {
        writeFileSync(resolve(flags.export), JSON.stringify({
          constellationId: id, version, cutoffDeg: cutoff, relTolerance: tol, result,
        }, null, 2));
        console.log('已导出:', flags.export);
      }
      store.close();
      break;
    }
    case 'help':
    case undefined:
      usage();
      break;
    default:
      console.error('未知命令:', command);
      usage();
      process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  if (e instanceof AppError) {
    console.error(`错误 [${e.code}]: ${e.message}`);
  } else if (e instanceof Error) {
    console.error('错误:', e.message);
  }
  process.exitCode = 1;
}
