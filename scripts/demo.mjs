// 端到端演示：构建后运行（node scripts/demo.mjs）。
// 依次演示：手算夹具、同仰角退化、加入高仰角恢复、截止等值、逐星移除、持久化幂等。
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { computeDOP, leaveOneOut } from '../dist/dop.js';
import { Store } from '../dist/store.js';

const line = (t) => console.log('\n=== ' + t + ' ===');

const hand = [
  { id: 'ZENITH', azimuthDeg: 0, elevationDeg: 90 },
  { id: 'H0', azimuthDeg: 0, elevationDeg: 0 },
  { id: 'H120', azimuthDeg: 120, elevationDeg: 0 },
  { id: 'H240', azimuthDeg: 240, elevationDeg: 0 },
];

line('1. 手算夹具');
const r1 = computeDOP(hand, 0);
console.log('状态', r1.status, '秩', r1.rank, '残差', r1.residual);
console.log('Q 对角', r1.Q.map((row, i) => row[i]).map((x) => x.toFixed(6)));
console.log('GDOP', r1.metrics.GDOP.toFixed(6), 'HDOP', r1.metrics.HDOP.toFixed(6), 'VDOP', r1.metrics.VDOP.toFixed(6));

line('2. 所有星同仰角 30°（退化：天向列与钟差列相关）');
const deg = [0, 60, 150, 230, 300].map((az, i) => ({ id: 'S' + i, azimuthDeg: az, elevationDeg: 30 }));
const r2 = computeDOP(deg, 0);
console.log('状态', r2.status, '秩', r2.rank);
console.log('原因', r2.reason);
console.log('主元', r2.pivot.values.map((v) => v.toExponential(2)));

line('3. 加入一颗 85° 高仰角星后恢复');
const r3 = computeDOP([...deg, { id: 'HIGH', azimuthDeg: 10, elevationDeg: 85 }], 0);
console.log('状态', r3.status, 'GDOP', r3.metrics?.GDOP.toFixed(4));

line('4. 方位角回绕与截止恰等值');
const wrap = [
  { id: 'W', azimuthDeg: -90, elevationDeg: 0 }, // -> 270
  ...hand.slice(1),
  hand[0],
];
const r4 = computeDOP(wrap, 0);
console.log('-90° 归一为', r4.satellites.find((s) => s.id === 'W').azimuthNormalized, '°');
const rCut = computeDOP(hand, 0);
console.log('截止=0° 时水平星是否保留（恰等值保留）:', rCut.satellites.filter((s) => s.selected).length, '颗');

line('5. 逐星移除（4 星 -> 缺星标记）');
for (const e of leaveOneOut(hand, 0)) {
  console.log('移除', e.removedId, '->', e.result.status, e.result.reason);
}

line('6. SQLite 持久化与幂等');
const dbPath = resolve('data/demo.db');
rmSync(dbPath, { force: true });
const store = new Store(dbPath);
const c = store.createConstellation('演示');
const v = store.importObservations(c.id, hand);
const a = store.upsertReport(c.id, v, 0, 1e-10, r1);
const b = store.upsertReport(c.id, v, 0, 1e-10, r1);
console.log('首次创建报告:', a.created, '重复请求创建:', b.created, '(同一 reportId=', a.report.id, ')');
store.close();
console.log('\n演示完成。数据库:', dbPath);
