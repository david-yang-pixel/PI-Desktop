# ADR: Push, pull requests, and cleanup for repository sessions

- Status: Accepted
- Date: 2026-11-20
- Related: D690, D693, [Environments and composer session targets](environments-and-session-targets.md)

## Context

A repository session has its own branch on a paired Host. Users need to publish
commits, open a pull request, and remove the checkout without losing work by
surprise.

## Decision

Electron main drives the Host's push job and searches GitHub for an open pull
request for the work branch before it creates one. A successful request is
recorded on the workspace binding. Publishing sends existing commits. Concurrent
actions in the same session join the same operation. Clicking the pull request
action checks GitHub for an open request. If none is open, Desktop clears the
old binding and offers to create a replacement.

Deletion checks for uncommitted files and unpushed commits. It asks for explicit
discard consent before removing a known dirty worktree. An offline deletion
records durable cleanup intent. On reconnect, cleanup removes clean worktrees
and retains worktrees with local work for explicit removal in Settings.
Automatic cleanup requires the Host's guarded removal capability. The same
conservative rule applies to unbound worktrees more than one day old.
Removing a checkout leaves the remote branch available on GitHub.

## Consequences

A disconnected Host can be cleaned up after the desktop restarts. Work that
cannot be inspected remains recoverable. Automatically committing changes or
forcing expiry-based cleanup would bypass the user's control of their work.

## Amendment: agent-owned publication

- Date: 2026-11-22
- Related: D693

Desktop no longer offers manual Push or Create pull request controls. The
conversation top bar shows context and links a recorded pull request; publishing
is the Agent's job. The renderer channels that drove the removed controls
(`remoteSession/git/status`, `remoteSession/git/push`,
`remoteSession/pullRequest/find`, `remoteSession/pullRequest/create`) are
removed, so the renderer can no longer start a push or create a pull request.
Deletion preflight and leftover worktree management keep their channels.

A ready repository session's Agent gets two tools that run in Electron main and
use the built-in GitHub connector:

| Tool | Behavior |
| --- | --- |
| `plugin_pi_github_PushSessionBranch` | Pushes the session's work branch through the Host's push job. An up-to-date branch returns `pushed: false` with the current counts, so the Agent can tell whether it still has to commit. |
| `plugin_pi_github_CreateSessionPullRequest` | Returns the open pull request for the work branch, or pushes when needed and opens one against the session's base branch. |

Both are offered whenever the connector is signed in and does not need
reauthentication, and the session's workspace is ready. The Connectors
setting "GitHub tools for the agent" governs only the issues and pull requests
MCP server; turning it off does not withdraw these tools, because they are now
the only way to publish a repository session. Both tools are high risk:
`ask` and `accept-edits` ask for approval unless the user allowed the tool for
the session, and `auto` runs them without asking. Host-core refuses them in Plan
and Goal turns (`PLUGIN_DISABLED_IN_PLAN`), and Electron main refuses any call
whose durable session mode is not Agent. Pushes still reach only the session's
own work branch through the Host's credential proxy, and neither tool commits
for the user.

Consequence: a user who wants a push or a pull request asks the Agent. A user
who signs out of the connector withdraws both tools at the next session launch.

## Amendment: merged and closed pull requests stay linked

- Date: 2026-11-22
- Related: D695

The lookup asks GitHub for the work branch's pull requests in every state,
not only open ones. The newest open request wins, otherwise the most recent
one. The binding's `pullRequest` record keeps that request's `state`
(`open`, `closed`, or `merged`) and `draft` flag as additive fields, so a
merged request no longer vanishes from the session. When GitHub returns
nothing the recorded link is kept: GitHub does not delete pull requests, and
an empty answer cannot prove the old one is gone.

`plugin_pi_github_CreateSessionPullRequest` returns an existing request only
while it is open. After a merge or close it pushes and asks GitHub for a new
request; GitHub refuses when the branch has no commits ahead of the base, and
that refusal is returned instead of the old request. Each session launch that
offers the publishing tools refreshes the recorded state in the background, at
most every five minutes and never after a merge.

Commits ahead of the base are counted against the base branch as the Host
last fetched it; `workspace/gitStatus` does not fetch. A stale base can only
cause an attempt that GitHub then validates. Fetching the base first needs a
Host change and is left for a later release.

