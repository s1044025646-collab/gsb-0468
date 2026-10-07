#!/usr/bin/env node
import { resolve } from 'node:path';
import { startServer } from '../server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let dbPath = resolve('data/gnss.db');
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = Number(args[++i]);
    } else if (args[i] === '--db' && args[i + 1]) {
      dbPath = resolve(args[++i]);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法: serve [--port 端口] [--db 数据库路径]');
      console.log('默认: 端口 0（自动选择空闲端口），数据库 data/gnss.db');
      process.exit(0);
    }
  }
  const { port: actual } = await startServer(dbPath, port);
  console.log(`GNSS DOP 服务已启动: http://127.0.0.1:${actual}`);
  console.log(`数据库: ${dbPath}`);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
