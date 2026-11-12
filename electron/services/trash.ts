import { shell } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanResult } from '../../shared/types';
import { dataDriveMounts } from './disk';
import { isManagedPath, PACKAGE_EXT } from './pathPolicy';
import { isInside, knownFolders, samePath } from './walk';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function systemRoots(): string[] {
  if (isWin) {
    const env = process.env;
    const drive = path.parse(os.homedir()).root || 'C:\\';
    return [
      env.SystemRoot || env.windir || path.join(drive, 'Windows'),
      env.ProgramFiles || path.join(drive, 'Program Files'),
      env['ProgramFiles(x86)'] || path.join(drive, 'Program Files (x86)'),
      env.ProgramW6432 || path.join(drive, 'Program Files'),
      env.ProgramData || path.join(drive, 'ProgramData'),
      path.join(drive, '$Recycle.Bin'),
      path.join(drive, 'System Volume Information'),
      path.join(drive, 'Recovery'),
    ];
  }
  return ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/cores', '/dev', '/Volumes'];
}

/** Top-level user folders that must never be trashed as a whole. */
const PROTECTED_TOP = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Movies', 'Music', 'AppData', 'Library', 'Applications',
  'OneDrive', 'iCloud Drive', 'Public', 'Favorites', 'Contacts', 'Links', 'Saved Games', 'Searches', '3D Objects',
  'iCloudDrive', 'Dropbox', 'Google Drive', 'Creative Cloud Files', '.Trash', '.local', '.config',
];

/** Places inside home that hold keys and credentials: nothing in or under them is ever touched. */
const SECRET_DIRS = [
  '.ssh', '.gnupg', path.join('Library', 'Keychains'),
  path.join('AppData', 'Roaming', 'Microsoft', 'Protect'),
  path.join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
  path.join('AppData', 'Local', 'Microsoft', 'Credentials'),
];

/** Top-level entries of a data drive (D:, /Volumes/Data) that belong to the OS or to app installers. */
const DRIVE_PROTECTED_TOP = new Set(
  (isWin
    ? [
        'Windows', 'Windows.old', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Recovery', 'Boot', 'EFI',
        'System Volume Information', 'Users', 'Documents and Settings', 'PerfLogs', 'Config.Msi', 'MSOCache',
        'WindowsApps', 'WpSystem', 'XboxGames', 'OneDriveTemp', 'bootmgr', 'BOOTNXT', 'BOOTSECT.BAK', 'pagefile.sys',
        'hiberfil.sys', 'swapfile.sys', 'DumpStack.log', 'DumpStack.log.tmp', 'desktop.ini', 'autorun.inf',
      ]
    : ['System', 'Library', 'Applications', 'Users', 'private', 'Backups.backupdb', 'cores', 'usr', 'bin', 'sbin', 'etc', 'var', 'opt']
  ).map((n) => n.toLowerCase()),
);

const CLOUD_TOP = /^(OneDrive( - .+)?|Dropbox|Google Drive|My Drive|iCloud ?Drive|Creative Cloud Files|Yandex\.?Disk)$/i;

function cloudRoots(): string[] {
  const env = process.env;
  return [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p): p is string => !!p && path.isAbsolute(p));
}

/** Strictly inside a data drive and outside its OS / installer folders. `mount` comes from listDisks(). */
function isSafeDrivePath(raw: string, abs: string, mount: string): boolean {
  if (isWin) {
    // drive-letter paths only: no UNC / \\?\ device paths, no alternate data streams ("file:stream")
    if (!/^[a-zA-Z]:[\\/]/.test(raw) || !/^[a-zA-Z]:\\$/.test(mount) || abs.indexOf(':', 2) !== -1) return false;
  }
  if (!isInside(mount, abs)) return false;
  const parts = path.relative(mount, abs).split(path.sep);
  const top = parts[0];
  if (!top) return false;
  // "$Recycle.Bin", "$WinREAgent" on Windows; ".Trashes", ".Spotlight-V100", ".fseventsd" on macOS
  if (top.startsWith(isWin ? '$' : '.')) return false;
  if (DRIVE_PROTECTED_TOP.has(top.toLowerCase())) return false;
  // Windows quietly drops trailing dots and spaces, so "Windows." would name the Windows folder
  if (isWin && parts.some((s) => /[. ]$/.test(s))) return false;
  if (isWin) for (const sys of systemRoots()) if (samePath(abs, sys) || isInside(sys, abs)) return false;
  // Documents, Desktop & co. are often redirected to a data drive: never trash them or a folder holding them
  for (const k of Object.values(knownFolders())) if (samePath(abs, k) || isInside(abs, k)) return false;
  // a sync root moved to a data drive: trashing it would delete everything in the cloud too
  if (parts.length === 1 && CLOUD_TOP.test(top)) return false;
  for (const c of cloudRoots()) if (samePath(abs, c) || isInside(abs, c)) return false;
  return true;
}

/**
 * Lexical guard for anything the renderer asks to move to the Trash.
 * Allows only paths strictly inside the home folder that are not OS folders, user root folders or key stores,
 * or (when `drives` lists them) paths on another fixed data drive outside its system folders.
 */
export function isSafeUserPath(p: unknown, home: string = os.homedir(), drives: readonly string[] = []): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) return false;
  if (!path.isAbsolute(p)) return false;
  const abs = path.resolve(p);
  if (path.parse(abs).root === abs || isManagedPath(abs)) return false;
  if (isSafeHomePath(abs, home)) return true;
  return drives.some((m) => !isInside(home, m) && !samePath(home, m) && !isInside(m, home) && isSafeDrivePath(p, abs, m));
}

function isSafeHomePath(abs: string, home: string): boolean {
  if (samePath(abs, home) || !isInside(home, abs)) return false;
  for (const sys of systemRoots()) if (samePath(abs, sys) || isInside(sys, abs)) return false;
  if (isMac && /^\/Applications\/?$/i.test(abs)) return false;

  const rel = path.relative(home, abs);
  const parts = rel.split(path.sep);
  if (parts.length === 1 && PROTECTED_TOP.some((n) => n.toLowerCase() === parts[0].toLowerCase())) return false;
  if (parts.length === 1 && /^OneDrive( - .+)?$/i.test(parts[0])) return false;
  // AppData\Local, AppData\Roaming, Library/Application Support and friends
  if (parts.length === 2 && /^(AppData|Library)$/i.test(parts[0])) return false;
  for (const s of SECRET_DIRS) {
    const sp = path.join(home, s);
    if (samePath(abs, sp) || isInside(sp, abs)) return false;
  }
  for (const k of Object.values(knownFolders())) if (samePath(abs, k)) return false;
  return true;
}

type Verdict = { kind: 'ok'; real: string } | { kind: 'blocked' } | { kind: 'gone' };

interface Drives {
  lexical: string[];
  /** the same mounts after realpath, for the canonical re-check */
  real: string[];
}

/** Fixed data drives from listDisks(); removable, network and unknown drives never qualify. */
async function dataDrives(): Promise<Drives> {
  let lexical: string[] = [];
  try {
    lexical = await dataDriveMounts();
  } catch {
    // without a drive list only the home folder qualifies
  }
  const real: string[] = [];
  for (const m of lexical) {
    try {
      const r = await fsp.realpath(m);
      if (samePath(r, m)) real.push(r);
    } catch {
      // unreadable drive: nothing on it qualifies
    }
  }
  return { lexical: lexical.filter((m) => real.some((r) => samePath(r, m))), real };
}

/**
 * Same guard, re-run on the canonical path. Resolving the full path (not just the parent) also
 * expands Windows 8.3 short names and trailing dots, so "DOCUME~1" or "Documents." cannot slip past
 * the protected-folder check, and a junction in a parent folder cannot point outside home.
 */
async function resolveSafe(p: string, drives: Drives): Promise<Verdict> {
  if (!isSafeUserPath(p, os.homedir(), drives.lexical)) return { kind: 'blocked' };
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return { kind: 'blocked' };
    const [realHome, real] = await Promise.all([fsp.realpath(os.homedir()), fsp.realpath(path.resolve(p))]);
    return isSafeUserPath(real, realHome, drives.real) ? { kind: 'ok', real } : { kind: 'blocked' };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'gone' } : { kind: 'blocked' };
  }
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Moves the user's own files to the system Trash so they can be restored. */
export async function trashPaths(paths: unknown): Promise<CleanResult> {
  const result: CleanResult = { freed: 0, removed: 0, failed: 0, skipped: [] };
  if (!Array.isArray(paths)) return result;

  const unique: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    if (!unique.some((u) => samePath(u, p))) unique.push(p);
  }
  let blocked = 0;
  let gone = 0;
  let locked = 0;
  let errors = 0;

  const drives = unique.length > 0 ? await dataDrives() : { lexical: [], real: [] };
  const allowed: string[] = [];
  for (const p of unique) {
    const verdict = await resolveSafe(p, drives);
    if (verdict.kind === 'gone') gone++;
    else if (verdict.kind === 'blocked') blocked++;
    // Trash exactly the canonical path that passed the guard; two spellings of one file collapse here.
    else if (!allowed.some((a) => samePath(a, verdict.real))) allowed.push(verdict.real);
  }
  // A file inside a folder that is also selected goes with the folder.
  const list = allowed.filter((p) => !allowed.some((o) => o !== p && isInside(o, p)));

  for (const p of list) {
    try {
      // Revalidate after traversal; reject a parent containing packages, links or managed data.
      const inspected = await inspectTree(p, undefined, true);
      if (!inspected) { blocked++; continue; }
      const again = await resolveSafe(p, drives);
      const last = await inspectTree(p, undefined, true);
      if (again.kind !== 'ok' || !samePath(again.real, p) || !last || last.fingerprint !== inspected.fingerprint) { blocked++; continue; }
      // Electron aborts (instead of deleting for good) when Windows cannot recycle an item,
      // e.g. it is bigger than the Recycle Bin or the bin is turned off; that lands in `errors`.
      await shell.trashItem(p);
      result.trashedBytes = (result.trashedBytes ?? 0) + inspected.size;
      result.removed++;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).toLowerCase();
      if (/in use|busy|being used|locked|sharing violation/.test(msg)) locked++;
      else errors++;
    }
  }

  result.failed = blocked + locked + errors;
  if (locked) result.skipped.push(`${plural(locked, 'item is', 'items are')} in use`);
  if (blocked) result.skipped.push(`${plural(blocked, 'item', 'items')} blocked for safety`);
  if (errors) result.skipped.push(`${plural(errors, 'item', 'items')} could not be moved to the Trash`);
  if (gone) result.skipped.push(`${plural(gone, 'item was', 'items were')} already gone`);
  return result;
}

export interface DeleteOutcome {
  freed: number;
  trashedBytes: number;
  removed: number;
  /** Files held open by another app. */
  locked: number;
  /** Files we are not allowed to delete (usually needs admin). */
  denied: number;
  /** The target failed the realpath / symlink check and was left alone. */
  refused: boolean;
}

export interface DeleteOptions {
  /** Entries must be wholly older than this cutoff and at least seven days old. */
  modifiedBefore?: number;
  /** Recheck the owning app immediately before the recoverable move. */
  canTrash?: () => Promise<boolean>;
}

/** Bounded, fail-closed inspection; no unlink/rmdir or fallback deletion. */
export async function inspectTree(target: string, cutoff?: number, personal = false): Promise<{ size: number; fingerprint: string } | null> {
  try {
    const first = await fsp.lstat(target);
    const stack = [target];
    let size = 0;
    const digest = createHash('sha256');
    let seen = 0;
    while (stack.length) {
      if (++seen > 50_000) return null;
      const p = stack.pop()!;
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return null;
      if (personal ? isManagedPath(p) : PACKAGE_EXT.test(path.basename(p))) return null;
      if (cutoff !== undefined && Math.max(st.mtimeMs, st.birthtimeMs || 0, (st.isFile() ? st.atimeMs : 0) || 0) >= cutoff) return null;
      digest.update(JSON.stringify([p, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs]));
      if (st.isDirectory()) {
        for (const name of (await fsp.readdir(p)).sort()) stack.push(path.join(p, name));
      } else size += st.size;
    }
    const last = await fsp.lstat(target);
    const fingerprint = (st: typeof first) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (fingerprint(first) !== fingerprint(last)) return null;
    return { size, fingerprint: digest.digest('hex') };
  } catch { return null; }
}

/** Moves one wholly stale cache entry to Trash, never permanently deletes anything. */
export async function trashCacheEntry(target: string, root: string, opts: DeleteOptions = {}): Promise<DeleteOutcome> {
  const out: DeleteOutcome = { freed: 0, trashedBytes: 0, removed: 0, locked: 0, denied: 0, refused: false };
  try {
    const [realRoot, realTarget] = await Promise.all([fsp.realpath(root), fsp.realpath(target)]);
    // Reject aliasing roots/parents as well as direct links. Caller supplies a derived cache root, never renderer input.
    if (!samePath(realRoot, root) || !samePath(realTarget, target) || !isInside(realRoot, realTarget)) {
      out.refused = true; return out;
    }
    const cutoff = Math.min(opts.modifiedBefore ?? Infinity, Date.now() - 7 * 86_400_000);
    if (!Number.isFinite(cutoff)) { out.refused = true; return out; }
    const item = await inspectTree(target, cutoff);
    if (!item) { out.refused = true; return out; }
    const check = await inspectTree(target, cutoff);
    if (!check || check.fingerprint !== item.fingerprint || check.size !== item.size) { out.refused = true; return out; }
    if (!samePath(await fsp.realpath(target), realTarget)) { out.refused = true; return out; }
    if (opts.canTrash && !(await opts.canTrash())) { out.refused = true; return out; }
    await shell.trashItem(realTarget);
    out.trashedBytes = item.size;
    out.removed = 1;
  } catch { out.denied++; }
  return out;
}
