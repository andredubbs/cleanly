module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const { requireReleaseCredentials } = await import('./release-policy.mjs');
  requireReleaseCredentials();
};
