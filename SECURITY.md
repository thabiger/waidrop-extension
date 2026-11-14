# Security policy

## Supported versions

Security fixes are provided for the latest `1.x` release. Pre-release or
unreleased development snapshots are not supported.

## Reporting a vulnerability

Please do **not** open a public issue for a security vulnerability.

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, browser/platform, a description, and
   reproduction steps.

If private reporting is unavailable, contact the maintainer at
`waidrop@tnkrd.com` with the subject line `WAiDrop extension security`.

Please do not include real chat content, archive keys, Dropbox tokens, or other
personal data in a report. Use synthetic examples where possible.

## Scope

Security-relevant areas include:

- MAIN-world store hook and content-script bridge authentication.
- Archive encryption (local IndexedDB records and Dropbox envelopes) and
  encryption-key handling.
- Dropbox OAuth, access-token and refresh-token handling.
- Capture behavior, manifest permissions and host permissions.
- Local data retention, offload and media repair.
- Packaging and release-pipeline integrity.

## Disclosure

Reports are acknowledged as soon as practical, investigated, and fixed on a
coordinated timeline. Please allow reasonable time for a fix before public
disclosure.
