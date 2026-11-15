import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { home, root, trash, control, trashed, calls } from './host';
import { isSafeUserPath, trashPaths, trashCacheEntry, inspectTree } from '../electron/services/trash';
import { scanLargeFiles } from '../electron/services/largeFiles';
import { cleanJunk, scanJunk } from '../electron/services/junk';
import { buildContext, askAi } from '../electron/services/ai';
import { getSettings, setSettings, setApiKey } from '../electron/services/settings';
import { listStartup, setStartup } from '../electron/services/startup';

const day = 86_400_000;
async function fixture(relative: string, data: string | Buffer = 'keep me') {
  const p = path.join(home, relative);
  await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); return p;
}
const progress = () => {};

test('production safety paths (fixture filesystem, mocked Electron/commands, no network)', async (t) => {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  try {
    for (const relative of [
      'Pictures/Family.photoslibrary/originals/photo.heic', 'Music/Audio.musiclibrary/database',
      'Downloads/Tool.app/Contents/Resources/data', 'Library/Application Support/Mail/mail.sqlite',
      '.ssh/id_ed25519', '.codex/config.toml', 'Projects/demo/.git/config',
      'Documents/iCloud Drive/project.pdf', 'Library/CloudStorage/Dropbox/a.pdf',
      'Documents/Work.xcodeproj/project.pbxproj',
    ]) await t.test(`blocks managed path ${relative}`, () => assert.equal(isSafeUserPath(path.join(home, relative)), false));

    await t.test('ordinary loose files qualify; traversal/root/relative input do not', () => {
      assert.equal(isSafeUserPath(path.join(home, 'Downloads', 'report.pdf')), true);
      for (const p of [home, path.join(home, 'Documents'), '/', '../secret', path.join(home, '..', 'outside'), 'https://host/path']) assert.equal(isSafeUserPath(p), false);
    });
    await t.test('backend refuses a package file and a parent containing a package', async () => {
      const p = await fixture('Pictures/Family.photoslibrary/originals/photo.heic');
      assert.equal((await trashPaths([p])).removed, 0);
      await fixture('Downloads/collection/Tool.app/Contents/data');
      assert.equal((await trashPaths([path.join(home, 'Downloads/collection')])).removed, 0);
      assert.equal(await fs.readFile(p, 'utf8'), 'keep me');
    });
    await t.test('rejects symlink targets and aliases into app data', async () => {
      const p = await fixture('Library/Application Support/secret.txt');
      const link = path.join(home, 'Downloads', 'alias');
      await fs.symlink(path.dirname(p), link);
      assert.equal((await trashPaths([path.join(link, 'secret.txt')])).removed, 0);
      assert.equal((await trashPaths([link])).removed, 0);
    });
    await t.test('loose-file removal uses recoverable Trash and reports zero freed bytes', async () => {
      const p = await fixture('Downloads/recoverable.txt');
      const out = await trashPaths([p, p]);
      assert.equal(out.removed, 1); assert.equal(out.freed, 0); assert.equal(out.trashedBytes, 7);
      assert.equal(await fs.readFile(path.join(trash, String(trashed.length - 1)), 'utf8'), 'keep me');
    });
    await t.test('Trash failure never falls back to deletion', async () => {
      const p = await fixture('Downloads/stays.txt'); control.trashError = true;
      try { assert.equal((await trashPaths([p])).removed, 0); assert.equal(await fs.readFile(p, 'utf8'), 'keep me'); }
      finally { control.trashError = false; }
    });
    await t.test('large-file discovery excludes packages and app data', async () => {
      const data = Buffer.alloc(1024 * 1024, 1);
      await fixture('Pictures/Huge.photoslibrary/originals/blob', data);
      await fixture('Library/Application Support/app/blob', data);
      const allowed = await fixture('Downloads/large.bin', data);
      const found = await scanLargeFiles(data.length, progress);
      assert.deepEqual(found.map((f) => f.path), [allowed]);
    });
    await t.test('fresh cache entries are retained', async () => {
      const p = await fixture('Library/Caches/Google/Chrome/fresh');
      const out = await trashCacheEntry(p, path.dirname(p));
      assert.equal(out.refused, true); assert.equal(await fs.readFile(p, 'utf8'), 'keep me');
    });
    await t.test('stale cache entry goes to Trash, never unlink', async () => {
      const p = await fixture('Library/Caches/Google/Chrome/old');
      Date.now = () => realNow() + 10 * day;
      try { const out = await trashCacheEntry(p, path.dirname(p)); assert.equal(out.removed, 1); assert.equal(out.freed, 0); assert.equal(out.trashedBytes, 7); }
      finally { Date.now = realNow; }
    });
    await t.test('cache root traversal, symlinks and packages are rejected', async () => {
      const rootDir = path.join(home, 'Library/Caches/Google/Chrome');
      const outside = await fixture('Downloads/outside');
      assert.equal((await trashCacheEntry(outside, rootDir)).refused, true);
      const p = await fixture('Library/Caches/Google/Chrome/Thing.app/data');
      assert.equal(await inspectTree(path.dirname(p), Date.now() + day), null);
      const link = path.join(rootDir, 'linked'); await fs.symlink(outside, link);
      assert.equal((await trashCacheEntry(link, rootDir)).refused, true);
    });
    await t.test('cache refuses invalid cutoff and an owner that restarts before removal', async () => {
      const p = await fixture('Library/Caches/Google/Chrome/restarted');
      Date.now = () => realNow() + 10 * day;
      try {
        assert.equal((await trashCacheEntry(p, path.dirname(p), { modifiedBefore: NaN })).refused, true);
        assert.equal((await trashCacheEntry(p, path.dirname(p), { canTrash: async () => false })).refused, true);
        assert.equal(await fs.readFile(p, 'utf8'), 'keep me');
      } finally { Date.now = realNow; }
    });
    await t.test('tree fingerprints change if a nested file changes', async () => {
      const p = await fixture('Downloads/snapshot/sub/file.txt', 'one');
      const first = await inspectTree(path.join(home, 'Downloads/snapshot'));
      await fs.writeFile(p, 'different');
      const second = await inspectTree(path.join(home, 'Downloads/snapshot'));
      assert.ok(first && second); assert.notEqual(first.fingerprint, second.fingerprint);
    });
    await t.test('one fresh child retains an entire cache group', async () => {
      const p = await fixture('Library/Caches/Google/Chrome/mixed/child');
      const before = trashed.length;
      assert.equal((await trashCacheEntry(path.dirname(p), path.dirname(path.dirname(p)))).refused, true);
      assert.equal(trashed.length, before);
    });
    await t.test('cleanup blocks running browsers and process-check failures', async () => {
      control.ps = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      await assert.rejects(cleanJunk(['browser-cache'], progress), /Close all browsers/);
      control.ps = '/sbin/launchd'; control.psError = true;
      await assert.rejects(cleanJunk(['browser-cache'], progress), /Close all browsers/);
      control.psError = false;
    });
    await t.test('removed broad-wipe and empty-Trash categories cannot execute through IPC', async () => {
      const count = trashed.length;
      const out = await cleanJunk(['mac-caches', 'mac-logs', 'xcode', 'dev-cache', 'trash', 'recycle-bin'], progress);
      assert.equal(out.removed, 0); assert.equal(trashed.length, count);
    });
    await t.test('scan and clean use whole-entry age guards; no auto-selection', async () => {
      await fixture('Library/Caches/Google/Chrome/scan-old');
      Date.now = () => realNow() + 10 * day;
      try {
        const found = await scanJunk(progress);
        assert.ok(found.some((c) => c.id === 'browser-cache'));
        assert.ok(found.every((c) => !c.safe));
        assert.ok(found.every((c) => !['mac-caches', 'mac-logs', 'xcode', 'trash'].includes(c.id)));
        const out = await cleanJunk(['browser-cache'], progress);
        assert.ok(out.removed > 0); assert.equal(out.freed, 0); assert.ok(out.trashedBytes! > 0);
      } finally { Date.now = realNow; }
    });
    await t.test('cloud AI defaults off even with a saved API key; request is blocked before network', async () => {
      assert.equal((await getSettings()).cloudAiEnabled, false);
      await setApiKey('chatgpt', 'synthetic-test-key-not-a-real-key');
      await assert.rejects(askAi('help', {}), /Cloud AI is off/);
      await assert.rejects(setSettings({ confirmBeforeClean: false }), /cannot be disabled/);
    });
    await t.test('cloud payload excludes names/paths/dates and drops invented suggestion paths', async () => {
      const ctx = { largeFiles: [{ path: path.join(home, 'Documents/private-client-secret.pdf'), size: 123, modified: 123456789 }], junk: [{ name: 'private-name', size: 10, locations: ['/private-location'] }], spaces: [{ name: 'secret-folder', size: 5 }] };
      const { data } = buildContext(ctx);
      const serialized = JSON.stringify(data);
      for (const secret of ['Andrew','private','secret','123456789','folder']) assert.ok(!serialized.includes(secret));
      await setSettings({ cloudAiEnabled: true, aiProvider: 'chatgpt' });
      let requests = 0;
      globalThis.fetch = async (_url, options) => {
        requests++; const body = String(options?.body);
        assert.ok(!body.includes('private-client-secret'));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Review first', suggestions: [{ path: 'item-2', verdict: 'safe', reason: 'review' }, { path: '/invented', verdict: 'safe' }] }) } }] }), { status: 200 });
      };
      const advice = await askAi('help', ctx);
      assert.equal(requests, 1); assert.equal(advice.suggestions.length, 1);
      assert.equal(advice.suggestions[0].path, ctx.largeFiles[0].path); assert.equal(advice.suggestions[0].verdict, 'review');
      await setSettings({ cloudAiEnabled: false });
      await assert.rejects(askAi('help', ctx), /Cloud AI is off/); assert.equal(requests, 1);
    });
    await t.test('startup backend rejects mutations without issuing commands', async () => {
      const count = calls.length;
      await assert.rejects(setStartup('mac:user:test.agent', false), /disabled/);
      assert.equal(calls.length, count);
      await fixture('Library/LaunchAgents/test.agent.plist', 'fixture');
      const items = await listStartup();
      assert.ok(items.length > 0); assert.ok(items.every((i) => !i.canToggle && !i.needsAdmin));
      assert.ok(calls.every((cmd) => !/bootout|bootstrap|osascript|launchctl (enable|disable)/.test(cmd)));
    });
  } finally {
    Date.now = realNow; globalThis.fetch = realFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});
