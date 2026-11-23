# ADR: Environments and composer session targets

- Status: Accepted
- Date: 2026-11-20
- Related: D689, [Remote git workspaces](remote-git-workspaces.md)

## Context

A repository can be shared by several sessions, while a session's tools need
their own branch and checkout. A named environment selects a paired Host and
provides setup configuration.

## Decision

The local Host stores environments, repository project markers, and per-session
workspace bindings in separate existing key-value namespaces. Every paired Host
exposes an implicit default environment. The composer resolves a target through
Electron main, which starts the remote prepare job, persists its id, and resumes
polling after a reconnect or restart. The existing durable prompt queue admits
new input until the binding is ready. Remote tools and files use the bound
checkout. Sessions without a ready binding fail closed in repository projects.

Forks prepare from the parent's local work branch and inherit its environment
and base branch. Scheduled sessions use the project's default branch and its
Host's default environment. The repository project is shared by sessions on the
same Host and repository.

The composer also allows No repository. Without a selected project folder,
this uses the existing RACP session/create flow without a project id. The
remote Host owns the session and its scratch directory, and provides the
default model. A selected remote folder continues to use the Desktop-owned
session and its local model. Either path can use saved environment setup and
variables on a Host that advertises `workspaceEnvironment`, without a GitHub
credential or worktree.

## Consequences

The main clone provides common Git storage. A per-session checkout protects
working files and permits parent-only commits to survive a fork. Environment
support adds optional RACP fields within the existing protocol version. A dedicated project per session would
duplicate navigation state. A new SQL table would require a schema migration.

## Amendment: preparation control and GitHub visibility

- Date: 2026-11-22
- Related: D696

The renderer can cancel a preparing workspace through
`remoteSession/workspace/cancel`. Electron main stops the Host job through the
existing cancel path and leaves the binding `failed` with
`REMOTE_WORKSPACE_CANCELLED`, so Retry prepares it again. Main also keeps the
last phase and progress of each preparing session in memory and returns them
with session reads, so a reloaded renderer does not fall back to a generic
status. Host-core and the persisted binding are unchanged.

The first send reconnects an offline Host instead of refusing it. The pickers
can look up one exact repository (`github/repository`) or branch
(`github/branch`) beyond the connector's capped lists, and conversation
details read `remoteSession/github/activity`: whether the work branch exists
on GitHub and, with a pull request, the CI state of its head commit. These
channels take a session id or exact names, spend the connector token only in
main, and are blocked on the local MCP control plane.

The primary New task keeps the remembered environment, repository, and branch.
