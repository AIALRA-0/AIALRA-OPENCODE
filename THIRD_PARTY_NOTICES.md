# Third-party notices

## OpenCode

AIALRA-OPENCODE interoperates with and builds a wrapper around a pinned release of OpenCode

OpenCode is copyright Anomaly and its contributors and is distributed under the MIT License, with upstream source and license available at <https://github.com/anomalyco/opencode>

The official OpenCode source is fetched at build time and remains unmodified, while the independent wrapper source in this repository is copied into a temporary upstream worktree for compilation

Compiled upstream assets are release outputs and are not committed to this source repository

## AIALRA-KIMI reference

The content-blind relay, host enrollment, short-lived authorization, and end-to-end channel design were derived from the AIALRA-KIMI public core at the commit recorded in `upstream.lock.json`

No Kimi runtime, model credential, session data, or production configuration is included

## Dependencies

JavaScript dependency names, versions, and integrity records are available in `pnpm-lock.yaml`, while the exact OpenCode source and official binary digests are recorded in `upstream.lock.json`

## Non-endorsement

AIALRA-OPENCODE is an independent, unofficial project and is not produced, sponsored, or endorsed by OpenCode, Anomaly, Moonshot AI, OpenCode Go, or any model provider
