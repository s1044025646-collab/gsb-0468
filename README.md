# GNSS 星座几何 DOP 与退化方向核验后端

教学用卫星定位**几何精度**分析服务。输入本地东(E)-北(N)-天(U)坐标系下各颗**虚构**卫星的方位角与仰角，
计算**未加权（等精度）DOP**，并解释星座几何退化。只提供 API 与 CLI，不含任何前端、地图或外部卫星服务。

## 边界与假设（务必先读）

- **只研究单位观测误差下的几何放大**：DOP 是无量纲几何数，**不是**米级定位精度，也不代表真实设备误差。
- 不读取星历、不估计真实接收机位置、**不解算伪距或钟差**、不调用地图或任何在线卫星 API。
- **等精度假设**：所有观测权重相同（未加权）。几何矩阵为带钟差列的 **4 未知数**矩阵，列顺序固定为
  **东、北、天、以等效距离计的钟差**。不会只算三个空间方向，也不会用卫星数量替代可解性检查。
- 视线单位向量（方位角从正北顺时针、仰角相对水平面向上）：
  - `E = cos(el)·sin(az)`，`N = cos(el)·cos(az)`，`U = sin(el)`
  - 每行 `H = [-E, -N, -U, 1]`
- 方位角接受任意有限度数并规范到 `[0,360)`；仰角接受 `0..90` 度。
- **不去重**：方向相同但 ID 不同的卫星保留为两条独立的等精度观测；但它们不增加新的几何方向。
- 指标定义（`Q = (H^T H)^-1`，交叉项保留，**不强行对角化**）：
  - `HDOP = sqrt(QEE + QNN)`
  - `VDOP = sqrt(QUU)`
  - `PDOP = sqrt(QEE + QNN + QUU)`
  - `TDOP = sqrt(QTT)`
  - `GDOP = sqrt(tr Q)`

## 秩判定与数值容差

- 自行构造 `H` 与 `H^T H`，用**全主元（行+列交换）高斯消元**求秩并在可逆时解出 `Q`，不调用任何现成 DOP 库。
- 公开两个尺度量：
  - **数值尺度 scale**：`H^T H` 中元素最大绝对值；
  - **相对主元容差 relTolerance**（默认 `1e-10`，可配置）；绝对判定阈值 = `relTolerance × scale`。
  - 另用逆矩阵残差容差 `RESIDUAL_TOL = 1e-7` 校验 `H^T H·Q ≈ I`。
- 状态枚举：
  - `OK`：满秩且残差合格；
  - `INSUFFICIENT_SATELLITES`：入选观测少于 4（只是必要条件不满足）；
  - `RANK_DEFICIENT`：`rank < 4`（例如**所有卫星同仰角**时天向列与钟差列线性相关）；
  - `NUMERIC_FAILURE`：`Q` 出现明显负对角，或 `H^T H·Q` 与单位矩阵残差超容差。
- 仅当负对角的绝对值在容差量级内（视为舍入误差）才修正为 0，并报告 `nearZeroFixes`；
  明显负值或逆矩阵验证失败一律判为数值失败，不输出貌似有限的精度。

## 仰角截止与逐星移除

- `cutoffDeg`：低于门槛的观测排除，**恰等于门槛保留**（`el >= cutoff` 入选），结果中分别报告入选/排除及原因。
- 逐星移除（leave-one-out）始终基于**同一原始输入与门槛重新独立计算**；缺星后不足 4 颗或退化会单独标记，
  失败结果使用全新矩阵，**不复用**上一份有效矩阵。批量比较上限 `MAX_BATCH = 64`。

## 约束与校验

- 卫星数量 `4..64`；ID 必须唯一；方位角有限，仰角 `0..90`；任一观测非法则**整批拒绝**。
- 错误码：`INVALID_PARAMS`、`SATELLITE_LIMIT`、`DUPLICATE_ID`、`INVALID_ANGLE`、`EMPTY_CONSTELLATION`、
  `NOT_FOUND`、`BATCH_LIMIT`、`NUMERIC_FAILURE`、`INTERNAL`。
- 重复计算请求**幂等**：相同（星座、版本、门槛、容差）返回同一冻结报告。

## 数据与版本

- SQLite（使用 Node 内置 `node:sqlite`，**无需原生编译、无需 Docker/WSL**）保存在项目内 `data/gnss.db`。
- 表保存角度原值、（计算结果中的）规范方向、选择规则（门槛/容差）与冻结结果 JSON。
- 修改观测或门槛会产生新版本；计算失败也保存诊断，但 `is_normal_precision = 0`，不会被当作正常精度报告。
- 重启后可用历史版本核对原始矩阵与全部候选/冻结结果。

## 环境要求

- Windows + Node.js（开发于 Node v25，内置 `node:sqlite`；建议 Node ≥ 22.5 并开启内置 SQLite）。
- 仅开发依赖 TypeScript / tsx / vitest，无运行时第三方依赖。

## 构建、测试、启动、演示

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # vitest：手算夹具 + 独立矩阵乘法 + 退化/回绕/截止/移除/API/持久化
npm start          # 启动 HTTP 服务，默认选择空闲端口并打印实际地址
npm run demo       # 运行端到端演示（CLI 核心 + 持久化幂等）
```

指定端口或数据库：

```powershell
npm start -- --port 8080 --db data/gnss.db
# 或开发模式直接跑 TS
npm run dev -- --port 8080
```

## CLI

```powershell
# 直接计算（从文件 / 内联 JSON / 标准输入）
node dist/bin/cli.js compute --file data/fixtures/handcalc.json
node dist/bin/cli.js compute --file data/fixtures/degenerate.json
node dist/bin/cli.js compute --file data/fixtures/handcalc.json --cutoff 15 --tol 1e-10

# 逐颗移除比较
node dist/bin/cli.js leave-one-out --file data/fixtures/handcalc.json

# 持久化：建星座 -> 冻结/复用报告 -> 导出
node dist/bin/cli.js create --name 手算 --file data/fixtures/handcalc.json
node dist/bin/cli.js report --id 1 --cutoff 0 --export data/report1.json
node dist/bin/cli.js help
```

输入格式：

```json
[
  { "id": "ZENITH", "azimuthDeg": 0,   "elevationDeg": 90 },
  { "id": "H0",     "azimuthDeg": 0,   "elevationDeg": 0  },
  { "id": "H120",   "azimuthDeg": 120, "elevationDeg": 0  },
  { "id": "H240",   "azimuthDeg": 240, "elevationDeg": 0  }
]
```

## HTTP API

仅监听 `127.0.0.1`。启动后根路径 `/` 列出全部路由。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/constellations` | 建立星座（可选随带 `satellites` 直接导入） |
| GET  | `/api/constellations/:id` | 查询星座、版本与当前观测 |
| PUT  | `/api/constellations/:id/observations` | 导入/覆盖方向表（产生新版本，非法整体拒绝） |
| GET  | `/api/constellations/:id/observations?version=N` | 查询矩阵来源（角度原值） |
| POST | `/api/constellations/:id/compute` | 按 `cutoffDeg`/`relTolerance` 计算并冻结（幂等） |
| POST | `/api/constellations/:id/leave-one-out` | 逐星移除比较 |
| GET  | `/api/constellations/:id/reports` | 列出冻结报告（含失败诊断标记） |
| GET  | `/api/reports/:id` | 报告详情（含 `H`、`H^T H`、`Q`、主元、残差、每星 H 行） |
| GET  | `/api/health` | 健康检查 |

示例：

```powershell
# 建星座
curl.exe -X POST http://127.0.0.1:8080/api/constellations -H "content-type: application/json" `
  -d '{\"name\":\"手算\",\"satellites\":[{\"id\":\"Z\",\"azimuthDeg\":0,\"elevationDeg\":90},{\"id\":\"A\",\"azimuthDeg\":0,\"elevationDeg\":0},{\"id\":\"B\",\"azimuthDeg\":120,\"elevationDeg\":0},{\"id\":\"C\",\"azimuthDeg\":240,\"elevationDeg\":0}]}'

# 计算（把 1 换成返回的 id；门槛与容差在 body）
curl.exe -X POST http://127.0.0.1:8080/api/constellations/1/compute -H "content-type: application/json" -d '{\"cutoffDeg\":0}'
```

## 手算核验夹具

`data/fixtures/handcalc.json`：1 颗天顶星（el=90）+ 3 颗水平星（el=0，az=0/120/240）。
解析解：

```
Q 对角 = (2/3, 2/3, 4/3, 1/3)
HDOP = VDOP = sqrt(4/3)
GDOP = sqrt(3)
```

测试中除断言上述解析值外，还用**独立矩阵乘法**核对 `H^T H·Q = I` 与手算的 `H^T H` 对角线，
而不只是比较本项目 API/CLI 两条调用路径。退化夹具见 `data/fixtures/degenerate.json`（5 颗同仰角 30°）。

## 几何精度边界（再次强调）

输出的 HDOP/VDOP/PDOP/TDOP/GDOP 仅描述**单位方差、等精度、独立观测**假设下协方差被放大的几何倍数；
要换算成距离误差必须另行给定观测误差标准差与误差模型，本服务刻意不做这一步。
