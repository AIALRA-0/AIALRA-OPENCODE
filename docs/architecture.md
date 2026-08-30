# Architecture

## Components

| Component                     | Responsibility                                                                                               | Explicit non-responsibility                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Official OpenCode App wrapper | Host selection, official session UI, encrypted fetch, event stream, and PTY transport                        | Does not store provider credentials or contact arbitrary servers       |
| Control plane                 | OIDC sessions, host inventory, short-lived grants, WebSocket routing, and ciphertext backpressure            | Does not terminate content encryption or inspect OpenCode requests     |
| Host Agent                    | Host identity, route validation, OpenCode supervision, HTTP and SSE forwarding, PTY lifecycle, and reconnect | Does not open a public listener or expose an arbitrary localhost proxy |
| Official OpenCode Server      | Authoritative projects, sessions, messages, tools, files, providers, and terminal APIs                       | Is not mirrored into the control-plane database                        |
| Private operations repository | Production inventory, object IDs, secret references, receipts, backup state, promotion, and rollback         | Does not alter public protocol behavior                                |

## Official App integration

`upstream.lock.json` selects an exact OpenCode tag, source commit, release target, archive digest, official binaries, OpenAPI digest, generated route manifest, and network-exit baseline

The build creates a temporary checkout and copies `upstream-overlay/aialra-remote-app` into it as a new package, then imports the public `AppBaseProviders`, `AppInterface`, and `ServerConnection` exports without changing upstream source files

The injected platform implementation handles all `Platform.fetch` traffic and the wrapper replaces WebSocket only when the destination belongs to a registered virtual host PTY

The network scanner counts platform fetch references and discovers direct WebSocket, EventSource, Worker, and global fetch construction, with any unrecorded exit blocking a candidate

## Identity and channels

1. The owner authenticates with OIDC Authorization Code and PKCE
2. A single-use pairing code enrolls a host and its Ed25519 public identity
3. The browser requests a short-lived grant bound to owner, host, scopes, expiry, and nonce
4. Browser and Agent exchange ephemeral X25519 keys through the relay
5. Both endpoints derive purpose-separated keys for HTTP, events, and PTY
6. XChaCha20-Poly1305 frames carry monotonically increasing sequence numbers
7. The relay validates authorization, destination, frame size, queue limits, and connection state without seeing plaintext

## OpenCode transport mapping

| Protocol object                                              | Purpose                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `HostDescriptor`                                             | Reports OpenCode version, OpenAPI digest, upstream commit, and capabilities         |
| `RouteCapabilityManifest`                                    | Allows methods, path templates, operation categories, body limits, and stream types |
| `RelayHttpRequest`                                           | Carries method, path, query, safe headers, and encrypted body                       |
| `RelayHttpResponseStart`                                     | Starts an ordinary or SSE response with status and safe headers                     |
| `RelayHttpChunk`                                             | Carries ordered encrypted bytes with bounded backpressure                           |
| `RelayHttpEnd` and `RelayHttpCancel`                         | Complete or cancel an in-flight request idempotently                                |
| `RelaySocketOpen`, `RelaySocketData`, and `RelaySocketClose` | Provide official PTY WebSocket compatibility                                        |

Request validation resolves the path against the generated manifest, rejects unknown methods and routes, constrains body size, strips unsafe headers, and validates any directory value before contacting loopback

The design never accepts a complete destination URL from the browser

## Session and host model

`HostSessionRef` is the pair `{ hostId, upstreamSessionId }`

Host identity remains part of every UI, request, event, and terminal key, so the same upstream identifier on two machines cannot collide

The target OpenCode database remains authoritative, while the control plane only stores enrollment and sanitized liveness data

When an Agent disconnects, the control plane marks its host offline and invalidates live channels, while the official UI keeps no central copy of session content

## OpenCode process boundary

The Agent selects a random loopback port, generates a random Basic Auth password, starts the pinned official `opencode serve`, and probes `/global/health` plus the runtime OpenAPI document

Provider configuration and authentication stay inside the service user's normal OpenCode data directories

The Agent does not accept provider keys through enrollment, browser frames, command arguments, or control-plane configuration

## Failure behavior

| Failure                      | Expected behavior                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser reconnect            | Reauthenticate if needed, request a fresh grant, recreate HTTP and event channels, and preserve official UI state where possible               |
| Agent reconnect              | Reauthenticate host identity, report the complete descriptor, and reject stale channel IDs                                                     |
| OpenCode restart             | Launch a new random loopback listener, reprobe version and OpenAPI, and fail closed on mismatch                                                |
| Control-plane restart        | Agents and the same browser page reconnect with bounded backoff, while pending writes to a closed socket fail without crashing either endpoint |
| Slow browser                 | Preserve ordered frames in a bounded queue and close the affected channel if the 64 MiB cap is exceeded                                        |
| Unsupported OpenCode version | Mark the host incompatible and block relayed operations                                                                                        |
| Route mismatch               | Return a sanitized rejection without contacting loopback                                                                                       |
| Host revocation              | Reject identity authentication and require explicit re-enrollment                                                                              |

## Excluded platform capabilities

- OpenCode self-update through the remote interface
- Public session sharing to external services
- Administrator terminal or system elevation
- Unregistered third-party OpenCode Servers
- Browser-side provider credential management

These exclusions are policy boundaries and are not silently re-enabled when upstream adds UI controls
