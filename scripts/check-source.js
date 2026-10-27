import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadProto } from '../shared/grpc.js';
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', '.git', 'doc', 'artifacts'].includes(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${path}: ${result.stderr}`);
    }
  }
}
await walk('.');
for (const name of ['auth', 'customer', 'product', 'order', 'shipment']) loadProto(name);
await readFile('compose.yaml', 'utf8');
console.log('JavaScript syntax and all five service proto contracts: PASS');
