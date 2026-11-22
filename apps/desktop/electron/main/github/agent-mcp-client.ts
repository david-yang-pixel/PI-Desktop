import { userMcpToolName } from "@pi-desktop/plugin-sdk";
import { GITHUB_MCP_URL } from "@pi-desktop/shared";
import { McpServerClient } from "../plugin-mcp";
import type { UserMcpClient, UserMcpClientConfig } from "../user-mcp";
import { createGitHubAgentRestTools } from "./agent-rest-tools";
import type { GitHubConnector } from "./connector";

class HostedAuthRejected extends Error {
  readonly code = "HTTP_ERROR";

  constructor(status: number) {
    super(`GitHub Hosted MCP rejected the credential (HTTP ${status}).`);
  }
}

function isAuthRejection(response: Response): boolean {
  return response.status === 401 || (response.status === 403 &&
    !response.headers.has("retry-after") && response.headers.get("x-ratelimit-remaining") !== "0");
}

export function createGitHubAgentMcpClient(
  config: UserMcpClientConfig,
  token: string,
  connector: () => Pick<GitHubConnector, "withAgentToolsDeviceToken"> | null,
  fetchImpl?: typeof fetch,
): UserMcpClient {
  const lifetime = new AbortController();
  const rest = createGitHubAgentRestTools({ fetchImpl });
  let rejection: HostedAuthRejected | undefined;
  let usingRest = false;
  const fallbackPrefix = userMcpToolName(config.server.id, "rest_");

  const redact = (value: string) => value.split(token).join("[redacted]");
  function redactValue(value: unknown): unknown {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") return redactFields(value);
    return value;
  }
  function redactFields(value: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [redact(key), redactValue(field)]));
  }
  function safeError(error: unknown): Error {
    const { code, errorCode } = (error as { code?: unknown; errorCode?: unknown } | null) ?? {};
    return Object.assign(new Error(redact(error instanceof Error ? error.message : String(error))), {
      ...(typeof code === "string" ? { code: redact(code) } : {}),
      ...(typeof errorCode === "string" ? { errorCode: redact(errorCode) } : {}),
    });
  }

  const hosted = new McpServerClient({
    ...config,
    fetchImpl: async (input, init) => {
      // The built-in credential and its tool requests are pinned to one endpoint.
      if (input !== GITHUB_MCP_URL) throw new Error("Unexpected GitHub Hosted MCP endpoint.");
      const response = await (fetchImpl ?? globalThis.fetch)(input, { ...init, redirect: "manual" });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("GitHub Hosted MCP redirected the request.");
      }
      if (isAuthRejection(response)) {
        void response.body?.cancel().catch(() => undefined);
        throw new HostedAuthRejected(response.status);
      }
      return response;
    },
    audit: config.audit ? (event) => config.audit?.(redactFields(event)) : undefined,
  });

  const useDeviceToken = async <T>(work: (activeToken: string) => Promise<T>) =>
    (await connector()?.withAgentToolsDeviceToken(token, work)) ?? null;

  function hostedTools() {
    return hosted.getTools()
      // Keep the fallback names distinct even if the hosted catalog changes.
      .filter((tool) => !userMcpToolName(config.server.id, tool.name).startsWith(fallbackPrefix) && !tool.name.includes(token))
      .map((tool) => ({
        ...tool,
        description: tool.description && redact(tool.description),
        inputSchema: redactValue(tool.inputSchema),
      }));
  }

  return {
    async connect() {
      try {
        lifetime.signal.throwIfAborted();
        if (usingRest) return rest.tools;
        if (!rejection) {
          try {
            await hosted.connect();
            return hostedTools();
          } catch (error) {
            if (!(error instanceof HostedAuthRejected)) throw error;
            rejection = error;
          }
        }
        const verified = await useDeviceToken((activeToken) => rest.verify(activeToken, lifetime.signal));
        lifetime.signal.throwIfAborted();
        if (!verified) throw rejection;
        usingRest = true;
        return rest.tools;
      } catch (error) {
        throw safeError(error);
      }
    },
    getTools() {
      if (lifetime.signal.aborted) return [];
      return usingRest ? rest.tools : rejection ? [] : hostedTools();
    },
    isConnected() {
      return !lifetime.signal.aborted && (usingRest || (!rejection && hosted.isConnected()));
    },
    async callTool(toolName, args, signal) {
      const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      let restCallStarted: number | undefined;
      try {
        active.throwIfAborted();
        if (usingRest) {
          restCallStarted = Date.now();
          const result = await useDeviceToken((activeToken) => rest.call(activeToken, toolName, args, active));
          if (result === null) throw new Error("The GitHub connection changed. Discover its tools again.");
          active.throwIfAborted();
          const output = { content: [{ type: "text", text: JSON.stringify(redactValue(result)) }] };
          auditRest(toolName, restCallStarted);
          return output;
        }
        if (rejection) throw new Error("GitHub Hosted MCP rejected the credential. Discover its tools again.");
        return redactValue(await hosted.callTool(toolName, args, active));
      } catch (error) {
        if (error instanceof HostedAuthRejected) {
          // A call may already have had a side effect. Only the next discovery
          // may select REST, and it advertises separate tool names.
          rejection = error;
          throw new Error("GitHub Hosted MCP rejected the credential. Check GitHub before trying the operation again.");
        }
        const failure = active.aborted && (error as Error | null)?.name === "AbortError"
          ? Object.assign(new Error("GitHub tool call cancelled."), { code: "TOOL_ABORTED" })
          : safeError(error);
        if (restCallStarted !== undefined) auditRest(toolName, restCallStarted, failure);
        throw failure;
      }
    },
    async ping() {
      try {
        if (usingRest) {
          const verified = await useDeviceToken((activeToken) => rest.verify(activeToken, lifetime.signal));
          if (!verified) throw new Error("The GitHub connection changed.");
        } else if (!rejection) {
          await hosted.ping();
        }
      } catch (error) {
        if (!(error instanceof HostedAuthRejected)) throw safeError(error);
        rejection = error;
      }
    },
    close() {
      lifetime.abort();
      hosted.close();
    },
  };

  function auditRest(toolName: string, started: number, error?: Error): void {
    config.audit?.(redactFields({
      api: `${config.auditScope ?? "mcp"}.call`,
      ok: !error,
      serverId: config.server.id,
      transport: "rest",
      tool: toolName,
      durationMs: Date.now() - started,
      ...(error ? { message: error.message } : {}),
      ts: Date.now(),
    }));
  }
}
