# Cleanly safety fork

Safety-focused fork of [0xCodez/cleanly](https://github.com/0xCodez/cleanly), based on upstream v0.1.1 (`5009618`). This changes the existing Electron app, not its visual design or technology stack. The fork uses the distinct app name **Cleanly Safety** and bundle ID `com.andredubbs.cleanly.safety`, so its installation/settings do not reuse the original app identity.

## What changed

- **Review, then Trash.** No auto-selected cleanup categories, no permanent cache deletion, and no empty-Trash command. Every cleanup requires confirmation. Moving files to Trash is not reported as newly freed disk space.
- **Protect managed data.** File discovery and removal share package/app-data protections. Photos/Music libraries, apps, development packages, hidden configuration, credential folders and recognized cloud-sync folders are not loose cleanup candidates. A selected parent containing protected data is refused too. The application uninstaller remains a separate, explicitly selected operation.
- **Conservative Mac caches.** Broad user-cache, log, developer-cache and Xcode wipes are removed. Only specific browser-cache locations remain; entries must be wholly older than seven days. Running browsers or a failed process check stop cleanup. Fresh files, symlinks, changed entries and oversized/unreadable trees are retained. Trash failure never falls back to deletion.
- **Cloud AI is off by default.** Saving a key does not enable it. After explicit opt-in, the provider receives typed questions, anonymous item IDs, sizes and disk totals, not scanned names, paths, dates or contents. Questions can themselves contain private information, and API charges may apply. Suggestions cannot invent a local path or mark a file automatically safe.
- **Startup inventory is read-only.** No LaunchAgent/registry enable, disable, restart or administrator fallback.
- **Mac packaging fails closed.** Developer ID signing, hardened runtime, notarization, a stapled app ticket and Gatekeeper assessment are required. No quarantine-removal instructions or unsigned fallback. Packaging is manual, with no tag-triggered publication.

## Verify without launching the app

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

Tests execute production service functions against isolated fixture files with a simulated Mac policy. Electron, OS command execution and network requests are mocked. They never load an Electron executable, access the real home folder or call a paid API. The tests exercise successful recoverable moves as well as refusal paths; no destructive test uses personal files.

`npm run build` creates the web renderer and main/preload bundles only. It does not launch or install the app. The browser demo uses synthetic data and the same default-off/read-only controls, but is not a native-app security test.

## Signed Mac packages

`npm run dist:mac` stops before packaging unless certificate and notarization credentials are configured. Direct electron-builder invocations are gated by `beforePack` too. After signing, the hook checks the Developer ID identity, hardened runtime, deep signature, stapled ticket and Gatekeeper acceptance before packaging artifacts are uploaded.

The manual **Signed Mac package** workflow accepts repository secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. These belong in the existing managed secrets route, never source control or logs. Local packaging also supports the electron-builder Apple API-key or keychain-profile credential routes. No certificate was created or purchased, and no notarized package has been produced as part of these source changes.

The **Safety checks** workflow runs tests and builds on pull requests and main. It does not start Electron, a simulator, or another device runtime. No binary release is automatically published.

## Limits and attribution

This is a safety-hardening patch, not a guarantee that all bugs or malware risks are eliminated. Paths can still change in the final interval before an OS Trash operation; revalidation narrows that window but is not an atomic filesystem transaction. Recovery depends on the system Trash and on not emptying it. Native signing/notarization and runtime verification remain distinct from source tests.

The original author is 0xCodez. Upstream currently declares `UNLICENSED`; this fork preserves that declaration and does not add a new license or publish redistributed binaries.
