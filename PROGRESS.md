# Cleanly safety hardening

## Request
Fork upstream and fix the safety issues found in Cleanly-mac-arm64.dmg 0.1.1. Keep all work in the background and leave the downloaded app unrun.

## Implemented
- Forked 0xCodez/cleanly at v0.1.1/5009618 into andredubbs/cleanly. Cleanly Safety 0.1.2 uses a separate app name/bundle ID and settings directory.
- Shared managed-path/package protections in large-file/duplicate discovery and the removal backend. Reject selected parents containing managed data, symlinks or unreadable/oversized trees; revalidate fingerprints before Trash.
- No permanent cache deletion or empty-Trash endpoint. Mac broad-cache/log/developer/Xcode wipes removed; specific browser caches require wholly stale entries and closed-browser checks. No automatic selections; review and confirmation remain mandatory.
- Source and browser-demo controls agree. Smart Scan opens review instead of deleting. Post-clean results rescan remaining items; Trash bytes are not presented as physically freed space.
- Explicit cloud-AI consent defaults off. Only typed questions and opaque IDs/sizes/disk totals leave the app after opt-in; names/paths/dates remain local. Unknown model suggestion IDs are dropped and safe verdicts downgraded.
- Startup mutations removed; inventory read-only, including backend calls.
- Mac release preflight and packaging hooks require Developer ID and notarization credentials, hardened runtime, a trusted signature, stapled app ticket and Gatekeeper acceptance. No unsigned fallback or automatic publication.

## Checks
- 29 production-service fixture tests plus 7 release-policy tests pass (36 reported tests, including parent test).
- Typecheck, renderer build and Electron main/preload bundling pass. No native app process launched.
- npm audit reports zero advisories across the locked dependency graph (including dev dependencies), October 29, 2026.
- actionlint passes; electron-builder configuration schema validated.
- Background-only built-renderer UI flow passes: cloud opt-in/revocation, confirmation stays on, chat disabled without consent, startup has no switches, cleanup starts unselected, confirmation describes Trash, Cancel returns to review. Settings capture inspected with animations disabled only in the harness.
- Actual `npm run dist:mac` entry point tested without credentials: refuses before packaging. Fork repository secrets list is empty. No signed/notarized installer has been produced or verified.

## Boundaries
- Fixture tests mock Electron Trash, network and OS commands; they are not a native runtime audit. The final path-to-Trash interval is not atomic; source documentation records this limit.
- Original DMG and quarantine unchanged; no installation, local device start, real user-file cleanup, paid API request, certificate creation or binary publication.
- Upstream UNLICENSED declaration preserved; no new license grant invented.
- No canonical Cleanly register row existed. Owner mapping requested in the existing Project Inbox: https://app.notion.com/p/408dc10367638151b6abd1daaac11c28 . Later Notion SQL/rows queries hit the workspace allowance; no duplicate tracker created or steward-review completion claimed.

## Remaining release work
Configure signing/notarization through the existing managed secrets route, then run the manual signed-package workflow and inspect its artifacts. This is not a code-test prerequisite and not represented as an already completed safety guarantee.
