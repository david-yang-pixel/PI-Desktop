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
