# Deployment

## Scope

This document defines the reusable deployment contract without production hostnames, IP addresses, account IDs, paths, credentials, or object identifiers

Store production inventory, identity and edge object state, secret references, deployment receipts, backup locations, cutover state, and rollback state in a separate private operations repository

## Prerequisites

- Linux VPS with systemd, Nginx, SQLite tooling, and TLS
- Windows workstation for the remote Agent
- Node.js 24.15.x, pnpm 10.33.4, and Bun 1.3.14 for builds
- OIDC provider supporting Authorization Code, PKCE, exact callback URLs, and owner-group authorization
- Optional edge proxy with WebSocket support, strict origin TLS, cache bypass, handshake limits, and Origin enforcement
- Release provenance or a signing mechanism verified before extraction
- Enough free space for one candidate, the active release, two rollback releases, and an isolated database migration copy

## Build and verify the public core

```bash
corepack enable # Select the repository-pinned pnpm
pnpm install --frozen-lockfile # Install the exact dependency graph
pnpm check # Run format, type, unit, and network-exit checks
pnpm build # Build protocol, control plane, and Agent
pnpm build:official-app # Build the zero-patch official App wrapper
pnpm verify:upstream # Recheck source, OpenAPI, manifest, and release locks
pnpm exec playwright install chromium # Install the local browser runtime once
pnpm test:e2e # Exercise the official UI and encrypted reconnect path
```

Do not promote an artifact from a dirty source tree

Record the source revision, toolchain versions, upstream-lock digest, artifact SHA-256, and provenance or signature with each release

## Build the immutable release

The release contains three independently deployable parts

1. Control-plane JavaScript and production dependencies
2. Agent JavaScript and production dependencies for Linux and Windows
3. The verified official App wrapper output from `apps/web/dist`

Install the pinned official OpenCode executable separately from the exact release URL and SHA-256 in `upstream.lock.json`

Never bundle a provider credential, Agent identity, OIDC secret, production environment file, OpenCode database, or model configuration

## Configure identity

Create one dedicated OIDC client for OpenCode ordinary access and do not reuse another application's client secret

Use exact HTTPS callback URLs, owner-group authorization, Authorization Code with PKCE, and normal MFA policy

Production must provide database, session, grant-signing, and OIDC client secrets through protected credential files, with `DEV_AUTH_BYPASS=0`

Canary and production may share the same OpenCode application only when both exact callbacks and audience behavior have been reviewed, otherwise use a separate temporary canary client and remove it after cutover

## Install the control plane

1. Create an unprivileged service account
2. Extract the verified artifact into a new immutable version directory
3. Create writable state outside the immutable release
4. Supply secret files with owner-only permissions
5. Point an atomic `current` link to the candidate
6. Start the service on a loopback address
7. Verify readiness, anonymous rejection, OIDC redirect, static CSP, SRI, and no-store headers over loopback
8. Expose only the reviewed Nginx upstream

Do not publish the Node listener, SQLite state, Agent, official OpenCode Server, or a host-local port directly to the Internet

## Install a host Agent

1. Create or select the ordinary OS account that owns OpenCode configuration and sessions
2. Install the exact official OpenCode binary from the lockfile into an immutable release directory
3. Complete OpenCode provider authentication locally under that account
4. Generate a one-time pairing code after owner login
5. Pass the code through a protected file or standard input, never a process argument
6. Enroll the Agent with exact version, upstream commit, runtime OpenAPI digest, and generated manifest
7. Install a user-level Windows scheduled task or a Linux systemd service
8. Verify the Agent creates only outbound control-plane traffic and a random authenticated loopback OpenCode listener

The VPS Agent and Windows Agent follow the same protocol and use distinct host identities

## Legacy session migration

Freeze the old service before copying SQLite state, then back up the database, WAL, SHM, configuration, executable, unit files, reverse-proxy configuration, and sanitized operational logs

Perform migration only on an isolated copy

1. Run SQLite integrity checks before migration
2. Copy the legacy database and sidecars together after a clean stop or use SQLite online backup
3. Present the copy to the new official OpenCode version under isolated data directories
4. Record migration logs and compare project, session, message, and representative read counts
5. Run integrity checks after migration
6. Import the migrated copy only when every gate passes

If migration fails, start the new service with an empty database and preserve the legacy state as read-only archive, without forcing incompatible rows into the new database

## Canary and production cutover

Canary must verify both VPS and Windows hosts, version and model-provider readback, ordinary project and session operations, files, diffs, MCP, tools, permissions, questions, HTTP, SSE, PTY, browser reconnect, Agent restart, OpenCode restart, and control-plane restart

Confirm that control-plane database, logs, and backups contain no prompt, response, code, file body, absolute path, provider key, or terminal content

After acceptance, atomically switch the production Nginx upstream while retaining the old Nginx configuration, systemd services, binaries, and database snapshot for seven days

Rollback restores the prior upstream, prior services, prior immutable release, and corresponding database copy, then reruns health and authorization checks

## Edge requirements

- Proxy only the intended hostname
- Require strict origin TLS
- Allow WebSocket upgrades only on reviewed browser and Agent relay paths
- Reject an unexpected Origin on the browser relay
- Disable caching on authentication, API, relay, and App HTML
- Rate-limit WebSocket handshakes
- Keep application frame, queue, sequence, replay, concurrency, and authorization controls because edge limits cover only the handshake
- Do not trust externally injected identity headers

## Automatic update contract

A scheduled check may discover the latest non-prerelease OpenCode version and open a candidate change

The candidate must verify source and binary digests, generate the OpenAPI route manifest, scan every official App network exit, build on Windows and Linux, test database migration, run unit and browser tests, and pass a dual-host canary

Discovery never promotes directly to production

Busy hosts wait until sessions and PTYs are idle, and the deployment keeps the active release plus two prior releases

Any health, authorization, migration, or relay-error regression rolls back to the previous verified release

## Acceptance gates

- Anonymous, expired, non-owner, revoked-host, replayed-grant, and forged-identity requests are rejected
- Two hosts with the same upstream session identifier remain isolated
- Unknown paths, methods, external URLs, arbitrary localhost, and unregistered servers are rejected
- HTTP, SSE, cancellation, and ordinary PTY pass on both supported operating systems
- OpenCode version, upstream commit, OpenAPI digest, capability manifest, provider, and selected model read back as expected
- Provider keys remain only in host-local native storage
- No internal listener is publicly reachable
- Control-plane persistence, logs, and backups remain content-blind
- Database migration either passes every integrity gate or cleanly falls back to an empty database with read-only legacy archive
- Rollback restores a healthy prior release and readable prior session state
