# GNSS 星座几何 DOP 与退化方向核验后端

教学用途的**卫星定位几何精度分析服务**（仅后端：HTTP API + CLI）。
输入本地站心坐标系（东 E、北 N、天 U）下各颗**虚构卫星**的方位角与仰角，
在**单位、等精度、不相关观测误差**假设下计算未加权 DOP（精度衰减因子），
并解释星座几何退化方向。

技术栈：**TypeScript + Node.js + SQLite**（SQLite 使用 Node 内置 `node:sqlite`，无需原生编译）。
本地直接运行，**不依赖 Docker、WSL、付费服务或任何外部在线 API/地图/星历**。

## 它做什么 / 不做什么

**做**
- 从方向角自行构造带钟差列的 4 未知数几何矩阵 `H` 与 `G = HᵀH`；
- 用**带部分主元的 Gauss–Jordan 消元**判定秩、求可逆时的 `Q = G⁻¹`；
- 由 `Q` 计算 HDOP/VDOP/PDOP/TDOP/GDOP，并输出主元、秩、`GQ−I` 最大残差；
- 仰角截止筛选（恰等于门槛保留）、入选/排除原因；
- 逐颗移除比较（每次基于同一原始输入与门槛**重新独立计算**）；
- SQLite 冻结原始角度、规范化方向、选择规则、容差与结果；修改观测或门槛产生新版本；重复请求幂等；失败只存诊断不冒充正常报告；重启后可核对原矩阵与全部候选结果。

**不做（边界）**
- 不读取星历、不估计真实接收机位置、不解算伪距/钟差；
- 不调用地图或外部卫星 API；
- **DOP 是无量纲几何放大数，不是米级定位精度，也不代表真实设备误差**；
- 仅适用于**等精度、互不相关观测**（未加权）；不做加权 DOP、不做时间相关误差建模。

## 数学约定

- 方位角 `az`：从**正北顺时针**，单位度；接受任意有限数，规范到 `[0,360)`（如 `-90 → 270`、`720 → 0`）。
- 仰角 `el`：相对水平面向上，单位度；必须在 `[0,90]`。
- 视线单位向量（站心 ENU）：

  ```
  E = cos(el)·sin(az)
  N = cos(el)·cos(az)
  U = sin(el)
  ```

- 几何矩阵每行（列顺序**固定**为东、北、天、以等效距离计的钟差）：

  ```
  H_row = [-E, -N, -U, 1]
  ```

- 满秩（rank = 4）时 `Q = (HᵀH)⁻¹`，指标：

  ```
  HDOP = sqrt(Q_EE + Q_NN)
  VDOP = sqrt(Q_UU)
  PDOP = sqrt(Q_EE + Q_NN + Q_UU)
  TDOP = sqrt(Q_TT)
  GDOP = sqrt(trace(Q))
  ```

  保留 `Q` 的全部交叉项与残差，**不强制对角化**。

## 秩判定与数值容差（公开）

- `pivotTol`（相对主元容差，默认 `1e-10`）：第 k 步在第 k 列选绝对值最大主元，
  若 `|pivot| / scale <= pivotTol`（`scale = max(当前矩阵最大元素绝对值, 1)`），判该方向缺失、秩不足。
- `residualTol`（逆矩阵残差容差，默认 `1e-8`）：要求 `max|GQ − I| <= residualTol`，否则判数值失败。
- 近零负对角：仅当 `Q_kk ∈ [-1e-10, 0)` 时按舍入误差归零并告警；明显负值或残差超差一律 `numeric_failure`。
- 状态：`ok` / `rank_deficient`（秩不足，不给有限指标）/ `numeric_failure`（数值失败）/ `insufficient_observations`（入选少于 4 条）。
- **至少四颗有效观测只是必要条件**。例如所有卫星仰角相同时，`-U` 列为常数、与钟差列 `1` 线性相关，即使有四颗甚至更多星也秩不足。
- 方向相同但 ID 不同的卫星**保留为两条独立等精度观测，不去重**；但它们不增加新的几何方向（不会据此误判可解性）。

## 手算核验夹具

1 颗天顶星 `(el=90°)` + 3 颗零仰角星 `(el=0°, az=0/120/240°)`，可手算得：

```
diag(Q) = (2/3, 2/3, 4/3, 1/3)
HDOP = VDOP = sqrt(4/3)
PDOP = sqrt(8/3), TDOP = sqrt(1/3), GDOP = sqrt(3)
```

测试除断言上述结果外，还用**测试文件内独立实现的矩阵乘法**重建 `G` 并验证 `GQ=I`（非仅比较项目内两条调用路径）。

## 环境要求

- Node.js `>= 22.5`（内置 `node:sqlite`；开发与验证使用 Node v25.5.0，Windows 本地）。
- 仅开发依赖：`typescript`、`tsx`、`@types/node`。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # node:test 运行 test/ 下全部用例（含手算夹具与独立矩阵核验）

npm start                          # 编译后启动；默认自动选择空闲端口，控制台打印实际端口
npm run dev                        # tsx 直接运行源码
$env:PORT=8080; npm start          # 或指定端口：--port 8080

npm run demo                       # 一键演示：夹具/退化/异仰角恢复/截止/逐星移除/导出报告
```

数据目录默认为项目内 `./data`（数据库 `data/dop.sqlite`），可用环境变量 `DOP_DATA_DIR` 覆盖。

## CLI

```powershell
npm run cli -- create my-constellation
npm run cli -- list
npm run cli -- import 1 examples/fixture.json
npm run cli -- compute 1 --cutoff 10 --pivot-tol 1e-10 --residual-tol 1e-8
npm run cli -- compare 1 --cutoff 10
npm run cli -- matrix-source 1
npm run cli -- report 1
```

观测 JSON 文件：`{ "satellites": [ { "id": "S1", "azDeg": 0, "elDeg": 0 }, ... ] }`。
卫星数量限制 **4..64**；ID 必须唯一；仰角越界、方位角非有限数、数量不符等**非法输入整体拒绝**。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/constellations` | 建立星座 `{ "name": "..." }` |
| GET | `/api/constellations` | 列出星座 |
| GET | `/api/constellations/:id` | 星座详情（版本、快照列表） |
| PUT | `/api/constellations/:id/observations` | 导入/替换方向表（首版填充，之后产生新版本） |
| POST | `/api/constellations/:id/compute` | 按门槛与容差计算并冻结（幂等） |
| POST | `/api/constellations/:id/compare` | 逐颗移除比较（批量上限 64） |
| GET | `/api/constellations/:id/matrix-source/:snapshotId?` | 查询冻结结果的矩阵来源（原观测、规则、容差、哈希） |
| GET | `/api/constellations/:id/report/:snapshotId?` | 导出完整 JSON 报告 |

`compute` / `compare` 请求体：

```json
{ "cutoffDeg": 10, "pivotTol": 1e-10, "residualTol": 1e-8, "obsVersion": 1 }
```

除 `obsVersion` 外均可选，默认 `cutoffDeg=0`、上述默认容差、使用最新版本。

快速调用（PowerShell）：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:<端口>/api/constellations -Method Post -ContentType 'application/json' -Body '{"name":"demo"}'
```

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_BODY` / `INVALID_JSON` | 请求体不是数组 / 不是合法 JSON |
| 400 | `INVALID_SATELLITE(_ID)` / `INVALID_AZIMUTH` / `INVALID_ELEVATION` | 观测字段非法（整体拒绝） |
| 400 | `DUPLICATE_SATELLITE_ID` | 卫星 ID 重复 |
| 400 | `TOO_FEW_SATELLITES` / `TOO_MANY_SATELLITES` | 数量超出 4..64 |
| 400 | `INVALID_CUTOFF` / `INVALID_TOLERANCE` | 截止值/容差非法 |
| 404 | `CONSTELLATION_NOT_FOUND` / `SNAPSHOT_NOT_FOUND` / `NOT_FOUND` | 资源不存在 |
| 409 | `CONSTELLATION_EXISTS` / `NO_OBSERVATIONS` | 名称冲突 / 尚未导入方向表 |
| 413 | `BODY_TOO_LARGE` | 请求体超过 1MB |
| 400 | `BATCH_LIMIT_EXCEEDED` | 批量比较超过上限（默认 64） |

## 版本与幂等

- 输入哈希（卫星 ID/原值角度、门槛、两项容差的规范化 JSON 的 SHA-256）作为冻结键；
  相同请求直接返回旧快照（`cached: true`），**重复请求幂等**。
- 观测变化创建新 `obs_version`；门槛/容差变化在同一版本下产生不同快照。历史版本与快照均可通过 `matrix-source` 复核。
- 秩不足/数值失败也会冻结，`status` 明确非 `ok`，**不会被标记为正常精度报告**。

## 目录结构

```
src/
  math/matrix.ts   矩阵与部分主元 Gauss–Jordan 求逆（无第三方线性代数库）
  math/dop.ts      方向规范化、H、G、秩、Q、DOP、退化解释、逐星移除
  validate.ts      参数校验与错误码
  db/store.ts      SQLite 表结构、版本、快照
  service.ts       计算编排与幂等
  api/server.ts    HTTP 路由、报告导出、空闲端口选择
  cli/cli.ts       命令行
  cli/demo.ts      一键演示
test/              手算夹具、退化、回绕、重复方向、截止恰等、近退化、移除不足、HTTP、重启核对
examples/fixture.json
```

## 限制与假设

- 仅未加权、等精度、独立观测；不支持加权/相关协方差。
- 角度几何理想化，忽略大气、遮挡信号强度、多路径与真实导航电文。
- DOP 仅刻画单位误差下的几何放大；换算成米级精度需自行乘以用户提供的观测误差模型，本服务不做该换算。
- `node:sqlite` 在当前 Node 版本标注为 experimental，但 API 稳定用于本教学后端；启动脚本已用 `--no-warnings` 抑制实验性提示。
