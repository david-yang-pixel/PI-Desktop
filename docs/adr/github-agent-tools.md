# ADR: GitHub tools for the Agent through the hosted MCP server

- Status: Accepted
- Date: 2026-11-20
- Related: D691, [Built-in GitHub connector](github-connector.md)

## Context

A GitHub connection can provide Issue and Pull Request tools to desktop
sessions. Existing user-configured MCP servers must keep their own credentials.

## Decision

Electron main adds an in-memory record for the GitHub-hosted MCP endpoint
with the `issues,pull_requests` toolsets. The MCP OAuth hook supplies the
connector token only to that specific built-in record. An existing server
named `github` takes precedence. Connectors settings can disable the built-in
server. A credential change closes its cached connections and refreshes the
workspaces' tool lists. Calls use the existing MCP tool permission rules.

## Consequences

The same credential can serve the desktop's GitHub REST operations and the
built-in MCP server. Existing user records keep their own credentials and
tools.

## REST fallback for Device Flow

Session discovery starts with GitHub Hosted MCP. An HTTP 401 or a 403
without `Retry-After` or `X-RateLimit-Remaining: 0` makes the built-in client
check the same Device Flow credential against `GET https://api.github.com/user`.
On success, the session discovers a smaller set under `mcp_github_rest_*`.
A REST 401 uses the connector's existing reauthentication path. PATs, custom
MCP servers, transport failures, redirects, and 429s do not activate fallback. The fallback
choice is in memory for the cached connection. Credential changes, disabling
the connector tools, and connection disposal reset it. A configured `github`
server still takes precedence in its workspace, even when disabled.

The REST tools go through session tool discovery and the existing MCP
permission and dispatch path. `ask` and `accept-edits` prompt for approval,
`auto` follows existing MCP policy, and Plan and Goal deny these tools. The
fallback names receive their own tool permissions. A hosted `tools/call` that
returns an access rejection fails as sent. Later discovery can expose the REST
tools. Each approved REST mutation sends a single request, and ambiguous
failures ask the caller to check GitHub before trying the write again.

| Tool suffix | Operation |
| --- | --- |
| `list_issues`, `issue_read` | List repository issues or read an issue by number, including its body. Issues exclude pull requests. |
| `list_pull_requests`, `pull_request_read` | List repository pull requests or read a pull request by number, including its body and branch refs. |
| `create_issue` | Create an issue with a title and optional body. |
| `add_issue_comment` | Post a conversation comment on an issue or pull request. |
| `create_pull_request` | Open a pull request between existing branches in the same repository, with optional body and draft status. |

Lists return one page of up to 30 entries and include a `hasMore` marker.
Search, comment history, diff and file reads, reviews, merges, edits, branch
creation and cross-repository pull request creation require another tool.
Repository access and writes remain subject to the token's GitHub scopes and
organization rules.

The connector token stays in main-process memory and goes only to the built-in
Hosted MCP endpoint and GitHub REST API. Neither transport follows redirects.
Tool definitions, results, status messages and logs redact a reflected token.
The REST tool inputs accept repository identifiers and operation fields.

## Device Flow acceptance

On 2026-11-21, the built-in connector obtained a token through GitHub Device
Flow using the OAuth App client ID from the
[`v0.23.1-pr.9` macOS package](https://github.com/david-yang-pixel/PI-Desktop/releases/tag/v0.23.1-pr.9).
GitHub REST accepted the same token for the connector's `/user` request.

The [manual probe](../../scripts/probe-github-mcp.mjs) used the
`issues,pull_requests` toolsets. Hosted MCP returned HTTP 200 for `initialize`,
HTTP 202 for `notifications/initialized`, and HTTP 200 for `tools/list`. The
list contained 20 tools, including `create_pull_request`, `pull_request_read`,
and `issue_read`.

This run verified token acceptance and tool discovery for the fork's OAuth
App. It ended at tool discovery, before invoking any tools.
