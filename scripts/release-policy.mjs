import path from 'node:path';

export function requireReleaseCredentials(env = process.env) {
  if (!env.CSC_LINK || !env.CSC_KEY_PASSWORD) throw new Error('Release requires a Developer ID certificate (CSC_LINK and CSC_KEY_PASSWORD). No unsigned fallback.');
  const api = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
  const account = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
  const keychain = env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE;
  if (!api && !account && !keychain) throw new Error('Release requires Apple notarization credentials. No unnotarized fallback.');
}

export function appPath(context) {
  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

export function requireTrustedSignature(details) {
  if (!/Authority=Developer ID Application:/.test(details) || !/TeamIdentifier=[A-Z0-9]{10}/.test(details) || !/flags=.*runtime/.test(details)) {
    throw new Error('Release app is not Developer ID signed with hardened runtime.');
  }
}
