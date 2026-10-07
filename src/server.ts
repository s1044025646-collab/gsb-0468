import { resolve } from "node:path";
import { Store } from "./db/store.js";
import { DopService } from "./service.js";
import { createApp, pickFreePort } from "./api/server.js";

async function main(): Promise<void> {
  const portArg = process.argv.indexOf("--port");
  const dataDir = process.env.DOP_DATA_DIR ? resolve(process.env.DOP_DATA_DIR) : resolve("data");
  const dbPath = resolve(dataDir, "dop.sqlite");
  const store = new Store(dbPath);
  const svc = new DopService(store);
  const server = createApp(svc);

  let port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT || 0);
  if (!Number.isInteger(port) || port <= 0) port = await pickFreePort();

  server.listen(port, "127.0.0.1", () => {
    console.log(`[gnss-dop] 服务已启动: http://127.0.0.1:${port}`);
    console.log(`[gnss-dop] 数据目录: ${dataDir}`);
    console.log("[gnss-dop] 健康检查: GET /health");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
