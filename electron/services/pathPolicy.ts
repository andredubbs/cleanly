import path from 'node:path';

/** Shared by discovery AND removal. Packages are indivisible, not loose user files. */
export const PACKAGE_EXT = /\.(app|photoslibrary|photolibrary|musiclibrary|tvlibrary|imovielibrary|fcpbundle|logicx|band|aplibrary|lrdata|lrlibrary|bundle|framework|plugin|kext|xcodeproj|xcworkspace|pkg|mpkg|sparsebundle|rtfd|pages|numbers|key|vmwarevm|pvm|utm)$/i;
const MANAGED = /^(Library|AppData|Applications|node_modules|bower_components|__pycache__|OneDrive( - .+)?|Dropbox|Google Drive|My Drive|iCloud ?Drive|Creative Cloud Files|CloudStorage)$/i;

export function isManagedPath(p: string): boolean {
  return path.resolve(p).split(path.sep).some((part) => part.startsWith('.') || MANAGED.test(part) || PACKAGE_EXT.test(part));
}
