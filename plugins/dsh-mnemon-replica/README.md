# DSH replica transport (experimental)

Install this Cordis plugin independently in the main and replica DSH profiles with `role: main` or `role: replica` and the same absolute `directory`. Give each instance its own `DSH_HOME`. The directory contains synthetic/test or user-authorized conversation progress, selected evidence and write receipts; protect it as conversation data.

The main instance broadcasts ordinary human input and completed assistant messages. Its Source creates fresh main-owned Views and ReadGrants from accepted evidence. The replica instance claims jobs and runs Agents through whichever AgentFactory its profile installed. Source runtimes, grants and action authority never cross the transport.

The atomic per-session transport uses interprocess file locks, revision/digest checks, work leases and immutable evidence snapshots. Changed input cancels stale work; stale publication is rejected. `pollMs` polls local files only. With `backgroundMs: 0`, unchanged input causes no model calls. An explicit positive interval permits background recomposition.

Main freshness is configured with `waitMs`, `maxRevisionLag` and `maxAgeMs`. Defaults wait zero and admit only the exact input revision. A bounded wait can obtain current evidence; a configured revision lag allows a previous snapshot while new work runs. An executing turn keeps its original View.

Plugins may share data through their own explicit directory/storage options. Installing the same package does not share its runtime instance. This transport does not proxy arbitrary plugin methods or override plugin authorization.

`reserveWrite` records an intention before a non-idempotent write. A surviving reservation with no outcome is **uncertain**, not proof of rollback; it is not automatically retried. Plugin-native idempotency is preferable when available. Evidence versions describe what the replica actually read; the bridge cannot certify that an unrelated third-party store has not changed since then.

See the [experiment design](../../docs/plans/jev-replica-agent-loop.md).
