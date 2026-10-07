import { rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve('data');
for (const name of readdirSync(dataDir)) {
  if (
    name.endsWith('.db') ||
    name.endsWith('.db-wal') ||
    name.endsWith('.db-shm') ||
    name === 'report1.json' ||
    name.startsWith('.tmp-')
  ) {
    rmSync(resolve(dataDir, name), { recursive: true, force: true });
  }
}
console.log('cleaned:', readdirSync(dataDir));
