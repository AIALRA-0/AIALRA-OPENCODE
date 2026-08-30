# Threat model

## Security objective

An authenticated single owner can control only enrolled hosts and manifest-approved OpenCode operations while OpenCode content, terminal data, provider credentials, and file bodies remain unreadable to the relay

## Protected assets

- Provider credentials and OpenCode authentication storage
- Agent identity private keys
- Session prompts, answers, tools, tasks, permissions, and questions
- Workspace files, absolute paths, PTY input, and PTY output
- OIDC client secret, control-plane session key, database key, and grant-signing key
- Official OpenCode release integrity, wrapper integrity, deployment receipts, and rollback state

## Trust boundaries

| Boundary                      | Trusted for                                                                    | Not trusted for                          |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| Browser                       | Owner interaction, official UI state, and plaintext before encryption          | Long-term provider or host credentials   |
| Edge and Nginx                | TLS routing, handshake filtering, and availability                             | User identity or content confidentiality |
| Control plane                 | OIDC session, short-lived authorization, host routing, and ciphertext queueing | OpenCode or PTY plaintext                |
| Host Agent                    | Host identity, route validation, OpenCode supervision, and plaintext endpoint  | Arbitrary network or localhost proxying  |
| Official OpenCode Server      | Authoritative sessions, tools, files, providers, and terminal API              | Exposure beyond authenticated loopback   |
| Private operations repository | Inventory, identifiers, secret references, receipts, and rollback coordination | Application content or raw secrets       |

## Threats and controls

| Threat                          | Primary controls                                                                                 | Residual risk                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Anonymous or non-owner access   | OIDC Code with PKCE, exact callback, owner-group policy, session checks                          | Identity-provider or owner-account compromise           |
| Stolen or replayed grant        | Short expiry, host and scope binding, nonce store, sequence validation                           | Compromised endpoint before expiry                      |
| Forged Agent                    | Ed25519 challenge, local protected key, enrollment, and revocation                               | Full compromise of the enrolled OS account              |
| Relay reads content             | Ephemeral X25519 and XChaCha20-Poly1305 purpose-separated frames                                 | Malicious frontend can read plaintext before encryption |
| Cross-host confusion            | `hostId` in grants, sessions, requests, events, channels, and PTYs                               | Implementation regressions require continuous tests     |
| SSRF or local pivot             | Generated route manifest, fixed loopback origin, safe headers, body limits, and directory checks | Defect in an allowed official operation                 |
| OpenCode local-service exposure | Random authenticated loopback listener and no public Agent port                                  | Host firewall or service-account compromise             |
| SSE or PTY replay               | Monotonic sequence numbers, channel purpose, bounded queue, reconnect state                      | Endpoint compromise can emit valid frames               |
| Slow consumer exhaustion        | Ordered 64 MiB per-connection cap and sanitized close                                            | Deliberate reconnect churn still consumes resources     |
| Sensitive logging               | Category-only audit schema and error sanitization                                                | New code may bypass the approved logger                 |
| Frontend supply-chain injection | Pinned source, zero-patch check, network scan, CSP, SRI, immutable release, provenance           | Compromised build or signing authority                  |
| Upstream network bypass         | Scanned `Platform.fetch`, WebSocket, EventSource, Worker, and global fetch baselines             | Novel browser primitive not covered by the scanner      |
| Database migration damage       | Pre-copy integrity, isolated migration, count comparison, post-check, immutable backup           | Upstream semantic changes not visible in counts         |
| Provider credential leakage     | Native host-local store, no browser key API, no key arguments or application logs                | Host-local OpenCode or OS compromise                    |

## Content-blindness definition

The control plane may process host identifiers, connection identifiers, request identifiers, authorization scopes, action categories, byte counts, timing, result codes, encrypted payloads, and sanitized liveness

It must not persist or log prompts, answers, source code, file bodies, terminal input, terminal output, absolute paths, destination URLs, provider account identifiers, or provider credentials

Ciphertext size and timing remain observable metadata and are not hidden by this design

## Official App supply-chain boundary

The same server that authenticates users also serves executable browser code, so a compromised deployment could capture plaintext before encryption

The mitigation is reproducible pinned source, zero upstream patches, an independently reviewable wrapper, no third-party scripts, strict CSP, SRI on entry assets, immutable releases, deployment digest verification, and restricted production operators

End-to-end encryption does not eliminate this frontend trust requirement

## Ordinary terminal boundary

PTY exposes the privileges of the OpenCode service account and is therefore a high-impact but non-administrative capability

The protocol binds PTY frames to one host and channel, applies authorization and frame limits, and closes the target on session end

Administrator terminal, system elevation, an administrator broker, and remote self-update are outside v1

## Out of scope

- Protecting content after the browser or enrolled host operating system is fully compromised
- Multi-tenant isolation
- Administrator terminal or system elevation
- Full remote desktop and GUI streaming
- Public session sharing
- Security of unofficial or unregistered OpenCode Servers
- Backing up unrelated workspaces or OpenCode message bodies into the control plane
- Hiding traffic timing and encrypted payload sizes from the relay

## Release security gates

Release candidates test identity bypass, WebSocket Origin, replay, host confusion, path traversal, SSRF, route mismatch, oversized frames, slow consumers, closed-socket recovery, secret leakage, upstream network exits, SRI, database migration, and rollback

Any unresolved secret, real-content fixture, unreviewed network exit, public internal listener, content-bearing log, integrity failure, or failed rollback blocks promotion
