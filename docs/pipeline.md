# CI/CD pipeline

## Validation

Pull requests and changes on `main` use Node 22 and run formatting, linting, TypeScript,
unit/integration tests, Chromium desktop/mobile accessibility tests, and an npm audit.
CodeQL runs on pull requests, `main`, and weekly. Dependabot checks npm, Docker, and
GitHub Actions weekly.

## Container publication

The multi-stage Docker build targets ARM64, uses an immutable Node base-image digest,
and publishes only the commit-SHA candidate first. BuildKit exports an SBOM and signed
provenance attestation. Trivy then blocks high or critical fixed vulnerabilities. Only a
passing candidate is promoted to `latest`; deployment always references the immutable
SHA.

All third-party Actions are pinned to commit SHAs. Dependabot proposes updates so those
pins remain reviewable and reproducible.

## Raspberry Pi deployment

The self-hosted ARM runner validates the 32-byte token-encryption key before making any
changes. A `flock` prevents concurrent deployments and `.env` is written atomically with
mode 0600. Compose pulls both services and starts the worker only after the web service,
including migrations, is healthy.

Both services run with the host deployment UID/GID, no Linux capabilities,
`no-new-privileges`, a read-only root filesystem, an init process, and a bounded `/tmp`
tmpfs. The SQLite `/data` bind mount is the only persistent writable location. The web
port is bound to loopback and the trusted reverse proxy supplies the external route.

## Maintenance and rollback

Weekly maintenance creates a SQLite online backup before pruning Docker artifacts and
retains 30 days. See `docs/backup-and-restore.md` for verification and restore steps.
Rollback consists of setting `IMAGE_TAG` to a previously scanned commit SHA and running
Compose again; never use `latest` as the rollback identifier.
