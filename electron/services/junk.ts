import { execFile } from 'node:child_process';
import { promises as fsp, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanResult, IconName, JunkCategory, ScanProgress } from '../../shared/types';
import { trashCacheEntry, inspectTree, isSafeUserPath, trashPaths } from './trash';
import {
  DAY_MS,
  displayPath,
  isInside,
  isRealDir,
  knownFolder,
  knownFolders,
  localAppData,
  mapLimit,
  roamingAppData,
  samePath,
  walk,
} from './walk';

type Progress = (p: ScanProgress) => void;

interface Root {
  path: string;
  /** Entry names directly in this root that belong to another category. */
  exclude?: string[];
}

interface Def {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  safe: boolean;
  kind: 'cache' | 'downloads' | 'recycle';
  roots?: () => Promise<Root[]>;
  /** Keep files modified after this moment (fresh temp files may belong to running apps). */
  keepNewerThanMs?: number;
  /** Shown when nothing could be removed because of permissions. */
  adminNote?: string;
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const OLD_DOWNLOAD_MS = 90 * DAY_MS;
const DOWNLOAD_IGNORE = new Set(['desktop.ini', 'thumbs.db', '.ds_store', '.localized']);

const home = () => os.homedir();
const lib = (...p: string[]) => path.join(home(), 'Library', ...p);

async function dirs(paths: string[], exclude?: (p: string) => string[] | undefined): Promise<Root[]> {
  const out: Root[] = [];
  for (const p of paths) {
    if (out.some((r) => samePath(r.path, p))) continue;
    if (await isRealDir(p)) out.push({ path: p, exclude: exclude?.(p) });
  }
  return out;
}

async function subdirs(p: string): Promise<string[]> {
  try {
    const list = await fsp.readdir(p, { withFileTypes: true });
    return list.filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
}

const PROFILE_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  path.join('Service Worker', 'CacheStorage'),
  path.join('Service Worker', 'ScriptCache'),
];
const USER_DATA_CACHES = ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];
const isProfileName = (n: string) => /^(Default|Profile \d+|Guest Profile|System Profile)$/i.test(n);

/** Cache folders of every profile of a Chromium "User Data" folder. */
async function chromiumCaches(userData: string): Promise<string[]> {
  if (!(await isRealDir(userData))) return [];
  const out = USER_DATA_CACHES.map((c) => path.join(userData, c));
  for (const profile of await subdirs(userData)) {
    if (isProfileName(path.basename(profile))) out.push(...PROFILE_CACHES.map((c) => path.join(profile, c)));
  }
  return out;
}

/** Opera keeps a single profile directly in its folder. */
const profileCaches = (profileDir: string) => PROFILE_CACHES.map((c) => path.join(profileDir, c));

async function firefoxCaches(profilesDir: string): Promise<string[]> {
  return (await subdirs(profilesDir)).map((p) => path.join(p, 'cache2'));
}

/** %TEMP% only if it looks like a real temp folder, never a root, home or user folder. */
function userTempDir(): string {
  const fallback = path.join(localAppData(), 'Temp');
  const t = os.tmpdir();
  if (samePath(t, fallback)) return t;
  // A custom TEMP such as Documents\tmp or a project's tmp folder holds the user's own files.
  const bad =
    path.parse(t).root === path.resolve(t) ||
    samePath(t, home()) ||
    isInside(t, home()) ||
    Object.values(knownFolders()).some((k) => samePath(k, t) || isInside(t, k) || isInside(k, t)) ||
    (isInside(home(), t) && !isInside(localAppData(), t)) ||
    !/^te?mp$/i.test(path.basename(t));
  return bad ? fallback : t;
}

function winDefs(): Def[] {
  const L = localAppData();
  const R = roamingAppData();
  const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const appCache = (base: string) => ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')].map((c) => path.join(base, c));

  return [
    {
      id: 'win-temp',
      name: 'Temporary files',
      description: 'Leftovers from installers and apps. Anything touched in the last day is kept.',
      icon: 'file',
      safe: true,
      kind: 'cache',
      keepNewerThanMs: DAY_MS,
      roots: () => dirs([userTempDir()]),
    },
    {
      id: 'win-system-temp',
      name: 'Windows temp',
      description: 'System-wide temporary files. Files Windows still uses are skipped.',
      icon: 'gear',
      safe: true,
      kind: 'cache',
      keepNewerThanMs: DAY_MS,
      roots: () => dirs([path.join(winDir, 'Temp')]),
    },
    {
      id: 'browser-cache',
      name: 'Browser caches',
      description: 'Chrome, Edge, Firefox and others rebuild these as you browse. Logins and history stay.',
      icon: 'globe',
      safe: true,
      kind: 'cache',
      roots: async () => {
        const userDatas = [
          path.join(L, 'Google', 'Chrome', 'User Data'),
          path.join(L, 'Microsoft', 'Edge', 'User Data'),
          path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data'),
          path.join(L, 'Vivaldi', 'User Data'),
        ];
        const paths: string[] = [];
        for (const u of userDatas) paths.push(...(await chromiumCaches(u)));
        for (const opera of ['Opera Stable', 'Opera GX Stable']) {
          paths.push(...profileCaches(path.join(L, 'Opera Software', opera)));
          paths.push(...profileCaches(path.join(R, 'Opera Software', opera)));
        }
        paths.push(...(await firefoxCaches(path.join(L, 'Mozilla', 'Firefox', 'Profiles'))));
        return dirs(paths);
      },
    },
    {
      id: 'app-cache',
      name: 'App caches',
      description: 'Discord, Slack, Teams, Spotify, VS Code and Zoom rebuild these on their own.',
      icon: 'apps',
      safe: true,
      kind: 'cache',
      roots: () => {
        const teamsNew = path.join(L, 'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView', 'Default');
        return dirs([
          ...appCache(path.join(R, 'discord')),
          ...appCache(path.join(R, 'Slack')),
          ...appCache(path.join(R, 'Microsoft', 'Teams')),
          path.join(R, 'Microsoft', 'Teams', 'tmp'),
          ...appCache(teamsNew),
          path.join(L, 'Spotify', 'Data'),
          path.join(L, 'Packages', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0', 'LocalCache', 'Spotify', 'Data'),
          ...appCache(path.join(R, 'Code')),
          path.join(R, 'Code', 'CachedData'),
          path.join(R, 'Code', 'CachedExtensionVSIXs'),
          path.join(R, 'Zoom', 'logs'),
        ]);
      },
    },
    {
      id: 'crash-reports',
      name: 'Crash dumps & error reports',
      description: 'Memory dumps and error reports apps left behind after a crash.',
      icon: 'warning',
      safe: true,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(L, 'CrashDumps'),
          path.join(L, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
          path.join(L, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
          path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
          path.join(programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'),
        ]),
    },
    {
      id: 'win-update',
      name: 'Windows Update downloads',
      description: 'Update installers Windows already used. Removing them needs admin rights.',
      icon: 'history',
      safe: false,
      kind: 'cache',
      adminNote: 'Windows Update files need admin rights, so they were skipped',
      roots: () => dirs([path.join(winDir, 'SoftwareDistribution', 'Download')]),
    },
    {
      id: 'dev-cache',
      name: 'Developer caches',
      description: 'npm, pip, Yarn, pnpm and Gradle caches. The next install downloads packages again.',
      icon: 'code',
      safe: false,
      kind: 'cache',
      roots: () =>
        dirs([
          path.join(L, 'npm-cache'),
          path.join(R, 'npm-cache'),
          path.join(L, 'pip', 'cache'),
          path.join(L, 'Yarn', 'Cache'),
          path.join(L, 'pnpm', 'store'),
          path.join(L, 'pnpm-store'),
          path.join(home(), '.gradle', 'caches'),
        ]),
    },
    {
      id: 'recycle-bin',
      name: 'Recycle Bin',
      description: 'Files you already deleted. Emptying it removes them permanently.',
      icon: 'trash',
      safe: false,
      kind: 'recycle',
    },
    oldDownloadsDef('Recycle Bin'),
  ];
}

function macDefs(): Def[] {
  const support = (...p: string[]) => lib('Application Support', ...p);
  return [
    {
      id: 'browser-cache',
      name: 'Browser caches',
      description: 'Only wholly stale cache entries (7+ days). Close all browsers first. Moved to Trash, not erased.',
      icon: 'globe',
      safe: true,
      kind: 'cache',
      roots: async () => {
        const paths = [
          lib('Caches', 'Google', 'Chrome'),
          lib('Caches', 'BraveSoftware', 'Brave-Browser'),
          lib('Caches', 'Microsoft Edge'),
          lib('Caches', 'Arc'),
          lib('Caches', 'company.thebrowser.Browser'),
          lib('Caches', 'com.apple.Safari'),
          lib('Caches', 'Vivaldi'),
          lib('Caches', 'com.operasoftware.Opera'),
        ];
        for (const u of [
          support('Google', 'Chrome'),
          support('BraveSoftware', 'Brave-Browser'),
          support('Microsoft Edge'),
          support('Arc', 'User Data'),
          support('Vivaldi'),
        ]) {
          paths.push(...(await chromiumCaches(u)));
        }
        paths.push(...(await firefoxCaches(lib('Caches', 'Firefox', 'Profiles'))));
        return dirs(paths);
      },
    },
    oldDownloadsDef('Trash'),
  ];
}

function linuxDefs(): Def[] {
  return [
    {
      id: 'linux-cache',
      name: 'User caches',
      description: 'Apps keep these to load faster and rebuild them when needed.',
      icon: 'layers',
      safe: true,
      kind: 'cache',
      roots: () => dirs([path.join(home(), '.cache')]),
    },
    {
      id: 'trash',
      name: 'Trash',
      description: 'Files you already deleted. Emptying it removes them permanently.',
      icon: 'trash',
      safe: false,
      kind: 'cache',
      // info/ holds the .trashinfo records; leaving them would show ghost items in the file manager.
      roots: () => dirs([path.join(home(), '.local', 'share', 'Trash', 'files'), path.join(home(), '.local', 'share', 'Trash', 'info')]),
    },
    oldDownloadsDef('Trash'),
  ];
}

function oldDownloadsDef(binName: string): Def {
  return {
    id: 'old-downloads',
    name: 'Old downloads',
    description: `Files in Downloads you have not touched for 90+ days. They go to the ${binName}, so you can restore them.`,
    icon: 'down',
    safe: false,
    kind: 'downloads',
  };
}

function platformDefs(): Def[] {
  const defs = isWin ? winDefs() : isMac ? macDefs() : linuxDefs();
  // No empty-Trash operation and no auto-selected categories. Cache cleanup is recoverable and aged.
  return defs.filter((d) => d.kind !== 'recycle' && d.id !== 'trash')
    .map((d) => ({ ...d, safe: false, keepNewerThanMs: Math.max(d.keepNewerThanMs ?? 0, 7 * DAY_MS) }));
}

const lower = (s: string) => s.toLowerCase();

interface Measured {
  size: number;
  count: number;
  locations: string[];
}

/** Sizes what a clean would remove: every entry inside each root, minus excluded and too-fresh files. */
async function measureCache(def: Def, roots: Root[], onTick: (current: string) => void): Promise<Measured> {
  const cutoff = Date.now() - Math.max(def.keepNewerThanMs ?? 0, 7 * DAY_MS);
  const out: Measured = { size: 0, count: 0, locations: [] };
  for (const root of roots) {
    const excluded = new Set((root.exclude ?? []).map(lower));
    let names: string[];
    try { names = await fsp.readdir(root.path); } catch { continue; }
    let bytes = 0;
    for (const name of names.slice(0, 50_000)) {
      if (excluded.has(lower(name))) continue;
      const p = path.join(root.path, name);
      onTick(p);
      const item = await inspectTree(p, cutoff);
      if (item) { bytes += item.size; out.count++; }
    }
    if (bytes > 0) { out.size += bytes; out.locations.push(displayPath(root.path)); }
  }
  return out;
}

/** Last opened (where the OS tracks it), changed or created: any of them makes a download "recent". */
const touched = (f: { mtimeMs: number; birthtimeMs: number; atimeMs: number }) =>
  Math.max(f.mtimeMs, f.birthtimeMs || 0, f.atimeMs || 0);

/** Top-level entries of Downloads whose content was all last touched 90+ days ago. */
async function findOldDownloads(): Promise<{ paths: string[]; size: number; folder: string }> {
  const folder = knownFolder('downloads');
  const cutoff = Date.now() - OLD_DOWNLOAD_MS;
  const result = { paths: [] as string[], size: 0, folder };
  let list: Dirent[];
  try {
    list = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    return result;
  }
  const candidates = list.filter((d) => !DOWNLOAD_IGNORE.has(lower(d.name)) && (d.isFile() || d.isDirectory()));
  await mapLimit(candidates, 8, async (d) => {
    const p = path.join(folder, d.name);
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) return;
      if (st.isFile()) {
        if (touched(st) < cutoff) {
          result.paths.push(p);
          result.size += st.size;
        }
        return;
      }
      if (!st.isDirectory()) return;
      let fresh = touched(st) >= cutoff;
      let size = 0;
      const ctrl = new AbortController();
      const stats = await walk(p, {
        signal: ctrl.signal,
        maxEntries: 200_000,
        onFile: (f) => {
          size += f.size;
          if (touched(f) >= cutoff) {
            fresh = true;
            ctrl.abort();
          }
        },
      });
      // A folder we could not fully check is treated as in use.
      if (stats.truncated) fresh = true;
      if (!fresh) {
        result.paths.push(p);
        result.size += size;
      }
    } catch {
      // unreadable: leave it alone
    }
  });
  result.paths = result.paths.filter((p) => isSafeUserPath(p));
  return result;
}

const RECYCLE_MEASURE = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$n=0; $t=[double]0',
  'foreach($i in (New-Object -ComObject Shell.Application).NameSpace(10).Items()){',
  '  $n++',
  "  $v=$i.ExtendedProperty('System.Size')",
  '  if($v -and [double]$v -gt 0){ $t+=[double]$v }',
  '  else { $m=(Get-ChildItem -LiteralPath $i.Path -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum; if($m){ $t+=[double]$m } }',
  '}',
  '"$n $t"',
].join('\n');

function powershell(script: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

async function measureRecycleBin(): Promise<{ count: number; size: number }> {
  try {
    const out = (await powershell(RECYCLE_MEASURE, 90_000)).trim().split(/\s+/);
    const count = Number(out[out.length - 2]);
    const size = Number(out[out.length - 1]);
    return { count: Number.isFinite(count) ? count : 0, size: Number.isFinite(size) ? size : 0 };
  } catch {
    return { count: 0, size: 0 };
  }
}

async function measure(def: Def, onTick: (current: string) => void): Promise<Measured> {
  if (def.kind === 'recycle') {
    const r = await measureRecycleBin();
    return { size: r.size, count: r.count, locations: ['Recycle Bin'] };
  }
  if (def.kind === 'downloads') {
    const r = await findOldDownloads();
    return { size: r.size, count: r.paths.length, locations: r.paths.length ? [displayPath(r.folder)] : [] };
  }
  const roots = (await def.roots?.()) ?? [];
  return measureCache(def, roots, onTick);
}

export async function scanJunk(progress: Progress): Promise<JunkCategory[]> {
  const defs = platformDefs();
  const found: JunkCategory[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    progress({ task: 'junk', phase: def.name, done: i, total: defs.length });
    let last = 0;
    const onTick = (current: string) => {
      const now = Date.now();
      if (now - last < 120) return;
      last = now;
      progress({ task: 'junk', phase: def.name, done: i, total: defs.length, current: displayPath(current) });
    };
    try {
      const m = await measure(def, onTick);
      if (m.size <= 0) continue;
      found.push({
        id: def.id,
        name: def.name,
        description: def.description,
        icon: def.icon,
        size: m.size,
        count: m.count,
        locations: m.locations.slice(0, 24),
        safe: def.safe,
      });
    } catch {
      // a category that cannot be measured is simply not offered
    }
  }
  progress({ task: 'junk', phase: 'Done', done: defs.length, total: defs.length });
  return found.sort((a, b) => b.size - a.size);
}

interface Tally {
  freed: number;
  trashedBytes: number;
  removed: number;
  locked: number;
  denied: number;
  refused: number;
}

async function cleanCache(def: Def, tally: Tally): Promise<void> {
  const roots = (await def.roots?.()) ?? [];
  const modifiedBefore = def.keepNewerThanMs ? Date.now() - def.keepNewerThanMs : undefined;
  for (const root of roots) {
    const excluded = new Set((root.exclude ?? []).map(lower));
    let names: string[];
    try {
      names = (await fsp.readdir(root.path)).filter((n) => !excluded.has(lower(n)));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') tally.denied++;
      continue;
    }
    await mapLimit(names, 4, async (name) => {
      const r = await trashCacheEntry(path.join(root.path, name), root.path, { modifiedBefore, canTrash: isMac ? browsersClosed : undefined });
      tally.freed += r.freed;
      tally.trashedBytes += r.trashedBytes;
      tally.removed += r.removed;
      tally.locked += r.locked;
      tally.denied += r.denied;
      if (r.refused) tally.refused++;
    });
  }
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Cleans the chosen categories. Locations are always re-derived here; the renderer only sends ids. */
export async function cleanJunk(ids: unknown, progress: Progress): Promise<CleanResult> {
  if (isMac && (Array.isArray(ids) && ids.includes('browser-cache')) && !(await browsersClosed())) {
    throw new Error('Close all browsers before moving caches to Trash. If their status cannot be checked, cleanup stays off.');
  }
  const wanted = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  const defs = platformDefs().filter((d) => wanted.has(d.id));
  const result: CleanResult = { freed: 0, removed: 0, failed: 0, skipped: [] };
  let locked = 0;
  let refused = 0;
  let deniedOther = 0;

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    progress({ task: 'clean', phase: def.name, done: i, total: defs.length });
    try {
      if (def.kind === 'downloads') {
        const { paths } = await findOldDownloads();
        const r = await trashPaths(paths);
        result.freed += r.freed;
        result.trashedBytes = (result.trashedBytes ?? 0) + (r.trashedBytes ?? 0);
        result.removed += r.removed;
        result.failed += r.failed;
        result.skipped.push(...r.skipped.map((s) => `Old downloads: ${s}`));
        if (r.removed > 0) result.skipped.push(`Old downloads went to the ${isWin ? 'Recycle Bin' : 'Trash'}, so you can restore them`);
        continue;
      }
      const tally: Tally = { freed: 0, trashedBytes: 0, removed: 0, locked: 0, denied: 0, refused: 0 };
      await cleanCache(def, tally);
      result.freed += tally.freed;
      result.trashedBytes = (result.trashedBytes ?? 0) + tally.trashedBytes;
      result.removed += tally.removed;
      result.failed += tally.locked + tally.denied;
      locked += tally.locked;
      refused += tally.refused;
      if (tally.denied > 0 && def.adminNote) result.skipped.push(def.adminNote);
      else deniedOther += tally.denied;
    } catch {
      result.failed++;
      result.skipped.push(`${def.name} could not be cleaned`);
    }
  }

  if (locked) result.skipped.unshift(`${fmt(locked)} ${locked === 1 ? 'file' : 'files'} in use`);
  if (deniedOther) result.skipped.push(`${fmt(deniedOther)} protected ${deniedOther === 1 ? 'file' : 'files'} left alone`);
  if (refused) result.skipped.push(`${fmt(refused)} fresh, linked or otherwise protected ${refused === 1 ? 'item' : 'items'} skipped for safety`);
  progress({ task: 'clean', phase: 'Done', done: defs.length, total: defs.length });
  return result;
}

/** Fail closed if process inspection fails. Browser helpers count as running too. */
async function browsersClosed(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'comm='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(false); return; }
      const processes = String(stdout).trim();
      resolve(processes.length > 0 && !/Chrome|Chromium|Safari|Brave|Microsoft Edge|Arc\.app|Firefox|Vivaldi|Opera|Browser\.app/i.test(processes));
    });
  });
}
