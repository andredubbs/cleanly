import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
await build({
  entryPoints: ['tests/safety.test.ts'], outfile: '.test-build/safety.test.cjs', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs',
  // Exercise the Mac policy on every CI host. No Electron executable or real user paths are loaded.
  define: { 'process.platform': '"darwin"' },
  alias: { electron: path.resolve('tests/host.ts'), 'node:os': path.resolve('tests/os.ts'), 'node:child_process': path.resolve('tests/host.ts') },
});
const result = spawnSync(process.execPath, ['--test', '.test-build/safety.test.cjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
