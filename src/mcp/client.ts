/**
 * Paperclip API client used by the MCP tool server.
 *
 * All HTTP requests from MCP tools go through this client so auth,
 * error normalization, and logging stay in one place. The client
 * reads its configuration from the process environment that Hermes
 * passes through to the spawned MCP subprocess (see `mcp_servers.paperclip.env`
 * in ~/.hermes/config.yaml written by the adapter).
 *
 * Env vars:
 *   PAPERCLIP_API_URL     base URL, e.g. "http://localhost:3100"
 *   PAPERCLIP_API_KEY     bearer token with the current agent's scope
 *   PAPERCLIP_AGENT_ID    UUID of the current agent (optional; some tools default to it)
 *   PAPERCLIP_COMPANY_ID  UUID of the current company (optional; same)
 */

export interface PaperclipConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string | null;
  companyId: string | null;
}

export class PaperclipClientError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(
    method: string,
    path: string,
    status: number,
    body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "PaperclipClientError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PaperclipConfig {
  const apiUrl = (env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "");
  const apiKey = env.PAPERCLIP_API_KEY ?? "";
  if (!apiUrl) {
    throw new Error(
      "PAPERCLIP_API_URL is not set. The MCP server needs this to reach the Paperclip API.",
    );
  }
  if (!apiKey) {
    throw new Error(
      "PAPERCLIP_API_KEY is not set. The MCP server cannot authenticate to Paperclip without it.",
    );
  }
  return {
    apiUrl,
    apiKey,
    agentId: env.PAPERCLIP_AGENT_ID ?? null,
    companyId: env.PAPERCLIP_COMPANY_ID ?? null,
  };
}

export interface PaperclipClient {
  readonly config: PaperclipConfig;
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
}

export function createClient(config: PaperclipConfig = loadConfig()): PaperclipClient {
  const base = config.apiUrl;
  const authHeader = `Bearer ${config.apiKey}`;

  const buildUrl = (path: string, query?: Record<string, string | number | undefined>) => {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  };

  async function request<T>(method: string, path: string, opts: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  } = {}): Promise<T> {
    const url = buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg = `${method} ${path} -> ${res.status} ${res.statusText}`;
      throw new PaperclipClientError(method, path, res.status, parsed, msg);
    }

    return parsed as T;
  }

  return {
    config,
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
    patch: (path, body) => request("PATCH", path, { body }),
  };
}
