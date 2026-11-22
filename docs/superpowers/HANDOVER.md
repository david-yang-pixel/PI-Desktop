# Handover: remote GitHub sessions on paired hosts

The original design and seven implementation plans are in
[`specs/`](specs/2026-11-20-remote-github-sessions-design.md) and
[`plans/`](plans/). The implementation follows these contracts.

| Part | Implementation |
| --- | --- |
| 1. Fork release pipeline | Unsigned macOS arm64 Desktop artifacts and Linux x64/arm64 Host bundles. The updater uses the fork's Releases page for unsigned builds. |
| 2. Host Git workspaces | Worktree recovery preserves existing branches and refuses unknown files. Non-forced removal checks for local commits even if the checkout disappeared. Tool Git uses the registry-backed proxy scope and fails closed without credentials. Job conflicts return the active job id. |
| 3. GitHub connector | Personal access tokens and configured device authorization. Navigation or renderer teardown stops device polling, and repeated unreadable client errors end the attempt. |
| 4. Environments and session targets | Home composer target selection, repository projects, scoped bindings, resumable preparation, and durable prompt admission. |
| 5. Git operations and cleanup | Agent-driven push and idempotent PR creation (no manual controls, D693), deletion preflight, deferred cleanup, and manual removal of leftover worktrees. |
| 6. GitHub tools for the Agent | A built-in issues and pull requests MCP record with connector credentials and user-configured server precedence. Repository sessions publish only through the Agent's push and pull request connector tools, which do not depend on the GitHub Agent tools switch (D693). |
| 7. Setup scripts and variables | Per-environment configuration, worktree setup, tool environment injection, and failure logs. |

For implementation details, see the [decisions log](../spec/08-meta/decisions-log.md)
and the [remote end-to-end scenarios](../spec/06-delivery/e2e/live-and-remote.md).

## Release acceptance

Done (details in
[Device Flow acceptance](../adr/github-agent-tools.md#device-flow-acceptance)):

- The fork's OAuth App public client ID is in the
  `PI_DESKTOP_GITHUB_OAUTH_CLIENT_ID` Actions variable, and the
  [`v0.23.1-pr.9`](https://github.com/david-yang-pixel/PI-Desktop/releases/tag/v0.23.1-pr.9)
  macOS package carried it. On 2026-11-21 its connector obtained a token through
  Device Flow, and GitHub REST accepted that token for `/user`. Personal access
  tokens remain supported.
- `scripts/probe-github-mcp.mjs` with that token reached hosted MCP:
  `initialize`, `notifications/initialized`, and `tools/list` succeeded, and the
  list had 20 tools from the `issues,pull_requests` toolsets.

Still open:

- Call a hosted MCP tool (`tools/call`) with a Device Flow token. The probe
  stops at tool discovery, so no hosted tool call has been verified yet.
- Verify an unsigned macOS arm64 package on a Mac, including manual update
  routing.
- Run the manual acceptance on the owner's paired Host: start a session from a
  private repository, let the Agent push its branch, and let it open the pull
  request.
- Cut a stable (non-prerelease) fork release with this work. `v0.23.0` is the
  latest stable release and predates D693; later work ships only in
  `v0.23.1-pr.N` prereleases. See the
  [release runbook](../spec/06-delivery/06-release-runbook.md).

General network policy for host commands and proxy-based GitHub upstream access
remain outside this design. The planned host connects directly to GitHub.
