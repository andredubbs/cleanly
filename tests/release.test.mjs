import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { requireReleaseCredentials, requireTrustedSignature } from '../scripts/release-policy.mjs';
import beforePack from '../scripts/before-pack.cjs';

test('release refuses missing certificate or notarization credentials', () => {
  assert.throws(() => requireReleaseCredentials({}), /Developer ID/);
  assert.throws(() => requireReleaseCredentials({ CSC_LINK: 'test', CSC_KEY_PASSWORD: 'test' }), /notarization/);
  assert.throws(() => requireReleaseCredentials({ CSC_LINK: 'test', CSC_KEY_PASSWORD: 'test', APPLE_ID: 'test' }), /notarization/);
});
test('complete credential shapes pass preflight without claiming notarization', () => {
  for (const notarize of [
    { APPLE_ID: 'test', APPLE_APP_SPECIFIC_PASSWORD: 'test', APPLE_TEAM_ID: 'test' },
    { APPLE_API_KEY: 'test', APPLE_API_KEY_ID: 'test', APPLE_API_ISSUER: 'test' },
    { APPLE_KEYCHAIN: 'test', APPLE_KEYCHAIN_PROFILE: 'test' },
  ]) assert.doesNotThrow(() => requireReleaseCredentials({ CSC_LINK: 'test', CSC_KEY_PASSWORD: 'test', ...notarize }));
});
test('real packaging entry point fails closed before packaging when credentials are absent', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CSC_|APPLE_)/.test(key)) delete env[key];
  const result = spawnSync(process.execPath, ['scripts/preflight-release.mjs'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Developer ID/);
});
test('beforePack hook gates direct mac packaging too', async () => {
  const saved = process.env.CSC_LINK; delete process.env.CSC_LINK;
  try { await assert.rejects(beforePack({ electronPlatformName: 'darwin' }), /Developer ID/); }
  finally { if (saved !== undefined) process.env.CSC_LINK = saved; }
});
test('shipping configuration has no unsigned or hardened-runtime opt-out', () => {
  const config = fs.readFileSync('electron-builder.yml', 'utf8');
  assert.match(config, /forceCodeSigning: true/); assert.match(config, /hardenedRuntime: true/);
  assert.match(config, /notarize: true/); assert.match(config, /afterSign: scripts\/after-sign.cjs/);
  assert.doesNotMatch(config, /identity: ['"]?-|hardenedRuntime: false|notarize: false|gatekeeperAssess: false/);
  const hook = fs.readFileSync('scripts/after-sign.cjs', 'utf8');
  for (const marker of ['requireTrustedSignature', 'stapler', 'spctl', '--strict']) assert.ok(hook.includes(marker));
});

test('signature policy rejects ad-hoc, missing runtime, and missing developer team', () => {
  assert.throws(() => requireTrustedSignature('Signature=adhoc\nTeamIdentifier=not set'), /Developer ID/);
  assert.throws(() => requireTrustedSignature('Authority=Developer ID Application: Test\nTeamIdentifier=ABCDE12345\nflags=0x0'), /Developer ID/);
  assert.throws(() => requireTrustedSignature('Authority=Developer ID Application: Test\nflags=0x10000(runtime)'), /Developer ID/);
  assert.doesNotThrow(() => requireTrustedSignature('Authority=Developer ID Application: Test\nTeamIdentifier=ABCDE12345\nflags=0x10000(runtime)'));
});

test('fork has a distinct app identity and settings directory name', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.productName, 'Cleanly Safety');
  assert.notEqual(pkg.name, 'cleanly');
  assert.match(fs.readFileSync('electron-builder.yml', 'utf8'), /appId: com\.andredubbs\.cleanly\.safety/);
});
