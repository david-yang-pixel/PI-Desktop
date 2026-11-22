import { ErrorCodes } from "@pi-desktop/shared";
import { createGitHubRequester, GitHubApiError, repositoryPath, type GitHubApiOptions } from "./github-api";
import { isGitBranchName } from "./names";

type Fields = Record<string, unknown>;
type RestOperation = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: Fields;
  result(json: unknown, response: Response): unknown;
};

type RestTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Fields; required: string[]; additionalProperties: false };
  operation(args: Fields, repo: string): RestOperation;
};

const text = { type: "string" };
const numberField = { type: "integer", minimum: 1 };
const stateField = { type: "string", enum: ["open", "closed", "all"], default: "open" };
const pageSize = { type: "integer", minimum: 1, maximum: 30, default: 20 };
const listFields = { state: stateField, page: numberField, perPage: pageSize };
const titleField = { type: "string", minLength: 1, maxLength: 256 };
const bodyField = { type: "string", maxLength: 65_536 };

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;
}

function invalid(field: string): GitHubApiError {
  return new GitHubApiError(ErrorCodes.INVALID_ARGUMENT, `Invalid GitHub tool argument: ${field}.`);
}

function unreadable(): GitHubApiError {
  return new GitHubApiError(ErrorCodes.GITHUB_NETWORK, "GitHub returned an answer that could not be read.");
}

function positiveInteger(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw invalid(name);
  return value;
}

function boundedText(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw invalid(name);
  return value;
}

function branch(value: unknown, name: string): string {
  if (!isGitBranchName(value)) throw invalid(name);
  return value;
}

function item(raw: unknown): Fields {
  const value = fields(raw);
  if (!value || typeof value.number !== "number" || typeof value.html_url !== "string") throw unreadable();
  return value;
}

function issue(value: Fields) {
  return {
    number: value.number,
    title: value.title,
    state: value.state,
    url: value.html_url,
    author: fields(value.user)?.login,
    updatedAt: value.updated_at,
  };
}

function pullRequest(value: Fields) {
  return {
    ...issue(value),
    draft: value.draft,
    merged: value.merged ?? (value.merged_at ? true : undefined),
    head: fields(value.head)?.ref,
    base: fields(value.base)?.ref,
  };
}

function list(args: Fields, path: string, pulls: boolean): RestOperation {
  const state = args.state === undefined ? "open" : args.state;
  if (state !== "open" && state !== "closed" && state !== "all") throw invalid("state");
  const page = positiveInteger(args.page === undefined ? 1 : args.page, "page");
  const perPage = positiveInteger(args.perPage === undefined ? 20 : args.perPage, "perPage", 30);
  return {
    method: "GET", path, query: { state, page: String(page), per_page: String(perPage) },
    result(json, response) {
      if (!Array.isArray(json)) throw unreadable();
      const entries = json.map(item);
      return {
        items: pulls ? entries.map(pullRequest) : entries.filter((value) => !value.pull_request).map(issue),
        page,
        hasMore: /;\s*rel="next"/.test(response.headers.get("link") ?? ""),
      };
    },
  };
}

function tool(name: string, description: string, properties: Fields, required: string[], operation: RestTool["operation"]): RestTool {
  return {
    name: `rest_${name}`,
    description: `${description} (GitHub REST fallback).`,
    inputSchema: {
      type: "object", properties: { owner: text, repo: text, ...properties },
      required: ["owner", "repo", ...required], additionalProperties: false,
    },
    operation,
  };
}

const tools = [
  tool("list_issues", "List one page of issues for a repository. Use hasMore to check for more pages", listFields, [],
    (args, repo) => list(args, `${repo}/issues`, false)),
  tool("issue_read", "Read an issue and its body by number", { number: numberField }, ["number"], (args, repo) => ({
    method: "GET", path: `${repo}/issues/${positiveInteger(args.number, "number")}`,
    result(json) {
      const value = item(json);
      if (value.pull_request) throw new GitHubApiError(ErrorCodes.INVALID_ARGUMENT, "Use the GitHub REST pull request tool for this number.");
      return { ...issue(value), body: value.body };
    },
  })),
  tool("list_pull_requests", "List one page of pull requests for a repository. Use hasMore to check for more pages", listFields, [],
    (args, repo) => list(args, `${repo}/pulls`, true)),
  tool("pull_request_read", "Read a pull request and its body by number", { number: numberField }, ["number"], (args, repo) => ({
    method: "GET", path: `${repo}/pulls/${positiveInteger(args.number, "number")}`,
    result(json) {
      const value = item(json);
      return { ...pullRequest(value), body: value.body };
    },
  })),
  tool("create_issue", "Create an issue in a repository", { title: titleField, body: bodyField }, ["title"], (args, repo) => ({
    method: "POST", path: `${repo}/issues`,
    body: {
      title: boundedText(args.title, "title", titleField.maxLength, true),
      ...(args.body === undefined ? {} : { body: boundedText(args.body, "body", bodyField.maxLength) }),
    },
    result: (json) => issue(item(json)),
  })),
  tool("create_pull_request", "Create a pull request between existing branches in the same repository", {
    title: titleField, head: text, base: text, body: bodyField, draft: { type: "boolean" },
  }, ["title", "head", "base"], (args, repo) => {
    if (args.draft !== undefined && typeof args.draft !== "boolean") throw invalid("draft");
    return {
      method: "POST", path: `${repo}/pulls`,
      body: {
        title: boundedText(args.title, "title", titleField.maxLength, true),
        head: branch(args.head, "head"), base: branch(args.base, "base"),
        ...(args.body === undefined ? {} : { body: boundedText(args.body, "body", bodyField.maxLength) }),
        ...(args.draft === undefined ? {} : { draft: args.draft }),
      },
      result: (json) => pullRequest(item(json)),
    };
  }),
  tool("add_issue_comment", "Post a conversation comment on an issue or pull request", {
    number: numberField, body: { ...bodyField, minLength: 1 },
  }, ["number", "body"], (args, repo) => ({
    method: "POST", path: `${repo}/issues/${positiveInteger(args.number, "number")}/comments`,
    body: { body: boundedText(args.body, "body", bodyField.maxLength, true) },
    result(json) {
      const value = fields(json);
      if (!value || typeof value.id !== "number" || typeof value.html_url !== "string") throw unreadable();
      return { id: value.id, url: value.html_url, body: value.body };
    },
  })),
];

export function createGitHubAgentRestTools(options: GitHubApiOptions = {}) {
  const request = createGitHubRequester(options);
  return {
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async verify(token: string, signal: AbortSignal): Promise<true> {
      const { json } = await request(token, "GET", "/user", undefined, undefined, signal);
      const login = fields(json)?.login;
      if (typeof login !== "string" || !login) throw unreadable();
      return true;
    },
    async call(token: string, name: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
      const definition = tools.find((candidate) => candidate.name === name);
      if (!definition) throw invalid("tool name");
      const args = fields(raw);
      if (!args || Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))) {
        throw invalid("arguments");
      }
      const path = repositoryPath({ owner: args.owner, name: args.repo });
      const operation = definition.operation(args, path);
      signal.throwIfAborted();
      try {
        const { json, response } = await request(token, operation.method, operation.path, operation.query, operation.body, signal);
        signal.throwIfAborted();
        return operation.result(json, response);
      } catch (error) {
        if (signal.aborted) {
          const message = operation.method === "POST"
            ? "GitHub tool call cancelled. Check GitHub before trying the write again."
            : "GitHub tool call cancelled.";
          throw Object.assign(new Error(message), { code: "TOOL_ABORTED" });
        }
        if (operation.method === "POST" && error instanceof GitHubApiError && error.errorCode === ErrorCodes.GITHUB_NETWORK) {
          throw new GitHubApiError(error.errorCode, `${error.message} Check GitHub before trying the write again.`, { status: error.status });
        }
        throw error;
      }
    },
  };
}
