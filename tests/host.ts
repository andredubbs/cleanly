import fs from 'node:fs';
import path from 'node:path';
export const root = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), 'test-fixture-')));
export const home = path.join(root, 'home');
export const trash = path.join(root, 'trash');
fs.mkdirSync(home); fs.mkdirSync(trash);
export const calls: string[] = [];
export const trashed: string[] = [];
export const control = { ps: '/sbin/launchd', psError: false, trashError: false };
export function execFile(file: string, args: string[], options: unknown, callback?: Function) {
  calls.push(`${file} ${args.join(' ')}`);
  const cb = typeof options === 'function' ? options : callback!;
  queueMicrotask(() => {
    if (file === '/bin/ps') cb(control.psError ? new Error('unavailable') : null, control.ps, '');
    else if (file.endsWith('plutil')) cb(null, JSON.stringify({ Label: 'test.agent', ProgramArguments: ['/tmp/test-agent'] }), '');
    else cb(null, '', '');
  });
}
export function spawn() { throw new Error('No child process may be started in regression tests'); }
export const app = {
  getPath: (key: string) => key === 'userData' ? path.join(home, 'state') : key === 'home' ? home : path.join(home, ({ desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', videos: 'Movies', music: 'Music' } as Record<string,string>)[key] ?? key),
  getVersion: () => '0.1.1',
};
export const shell = {
  trashItem: async (p: string) => {
    if (!p.startsWith(home + path.sep)) throw new Error('Test tried to touch nonfixture data');
    if (control.trashError) throw new Error('Trash unavailable');
    await fs.promises.rename(p, path.join(trash, String(trashed.length)));
    trashed.push(p);
  },
};
export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'test',
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
