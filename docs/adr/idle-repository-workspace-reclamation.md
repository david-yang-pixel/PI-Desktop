# ADR: Idle repository workspace reclamation

- Status: Accepted
- Related: [Remote Git workspaces](remote-git-workspaces.md), [Remote environment setup](remote-environment-setup.md)

## Context

Repository sessions keep linked Git worktrees on paired Hosts. Each checkout
may accumulate its own dependency and build directories long after a turn ends.
Users still need the transcript and the exact commit when they return to a task.

## Decision

Desktop periodically selects idle candidates on connected Hosts using the last
finished task or workspace operation. An environment controls the idle interval.
The remote Host owns the final safety decision and holds the same workspace lock
used for tool and Git admission through inspection and reclamation. A checkout
with unpublished commits, uncommitted changes, untracked files, protected
ignored files, or uncertain state stays in place. Declarations in the
repository or environment identify ignored, regenerable directories. Ignored
`node_modules` directories are automatically eligible.

The Host persists recovery data before removing checkout contents and retains
the work branch, exact commit, registry record, and shared repository. Desktop
holds durable input while the outcome is uncertain. Opening the transcript is a
local operation. Newly queued input wakes a reclaimed checkout and proceeds
after initialization succeeds. A retry can run initialization again on the
same checkout when the first attempt fails.

## Consequences

After a successful reclaim, the Linux and macOS Host attempts an incremental
Git repack under the shared repository lock. It packs loose objects and removes
redundant loose copies while preserving the clone, refs, existing history, and
linked worktree metadata. The repack has a five-second limit. A repack failure
leaves the completed reclaim available for wake. Protected or ambiguous
workspaces can continue to use disk space until the operator resolves
the reason for retention. Hosted work turns still depend on Desktop. Hosts that
have not negotiated reclamation remain eligible for the existing workspace
operations without automatic reclamation.
