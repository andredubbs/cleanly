const { execFileSync, spawnSync } = require('node:child_process');
module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const { appPath, requireTrustedSignature } = await import('./release-policy.mjs');
  const app = appPath(context);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' });
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) throw new Error('Could not inspect release signature.');
  requireTrustedSignature(details);
  // electron-builder notarizes before afterSign. Missing/failed notarization must stop packaging.
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app], { stdio: 'pipe' });
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'pipe' });
};
