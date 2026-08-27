/**
 * A minimal MCP client over Streamable HTTP.
 *
 * SearchAtlas publishes its programmatic surface at `https://mcp.searchatlas.com/mcp`
 * rather than as documented REST routes, and their own npm bridge
 * (`searchatlas-mcp-server`) is a thin forwarder to it — it hard-codes no paths
 * at all, which is why no amount of path guessing was ever going to work.
 *
 * That transport is not an integration to install: it is an HTTPS POST carrying
 * a JSON-RPC body, authenticated by the same `X-API-Key` header the REST
 * adapter already uses. So this file is a few dozen lines of `fetch` rather than
 * an SDK dependency, a subprocess, or anything wired into the agent's own MCP
 * configuration — that machinery is what was deliberately removed, and none of
 * it comes back.
 *
 * What the protocol needs beyond a plain POST:
 *
 *   - `initialize`, then an `initialized` notification, before any other call.
 *   - `Mcp-Session-Id` echoed back on every subsequent request when the server
 *     issues one.
 *   - Replies arriving either as JSON or as SSE frames, decided per request by
 *     the server, so both have to be understood.
 */

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** The version this client speaks. Servers negotiate down if they must. */
const PROTOCOL_VERSION = "2025-06-18";

const REQUEST_TIMEOUT_MS = 120_000;

export class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly authHeaders: Record<string, string>,
    private readonly clientName = "seo-articles",
  ) {}

  /* ------------------------------------------------------------ transport */

  private headers(): Record<string, string> {
    return {
      ...this.authHeaders,
      "content-type": "application/json",
      // Either is acceptable to us; the server picks per response.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  /**
   * Reads one JSON-RPC reply, whichever framing the server chose.
   *
   * SSE streams are read incrementally and abandoned as soon as the frame
   * carrying our id arrives: a server is entitled to hold the stream open
   * afterwards, and waiting for it to close would stall every call until the
   * timeout.
   */
  private async readReply(
    response: Response,
    id: number,
  ): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("text/event-stream")) {
      const text = await response.text();
      if (!text.trim()) {
        throw new McpHttpError("Empty response body", response.status);
      }
      return JSON.parse(text) as JsonRpcResponse;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new McpHttpError("SSE response had no body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split: number;
        while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, "");

          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");

          if (!data) continue;

          const parsed = JSON.parse(data) as JsonRpcResponse;
          // Servers may interleave notifications and progress on the same
          // stream; only the frame answering this request ends the read.
          if (parsed.id === id) return parsed;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    throw new McpHttpError("SSE stream ended before the reply arrived");
  }

  private async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const id = this.nextId++;

    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new McpHttpError(
        `${method} → ${response.status} ${response.statusText}. ${body.slice(0, 400)}`,
        response.status,
        body,
      );
    }

    const reply = await this.readReply(response, id);
    if (reply.error) {
      throw new McpHttpError(
        `${method} → ${reply.error.message} (code ${reply.error.code})`,
      );
    }
    return reply.result;
  }

  /** Fire-and-forget; notifications carry no id and expect no reply. */
  private async notify(method: string): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      // A server that rejects the notification still works for requests; this
      // is a courtesy in the handshake, not a precondition.
    });
  }

  /* ---------------------------------------------------------------- calls */

  async connect(): Promise<{ name?: string; version?: string }> {
    if (this.initialized) return {};

    const result = (await this.send("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: "1.0.0" },
    })) as { serverInfo?: { name?: string; version?: string } };

    await this.notify("notifications/initialized");
    this.initialized = true;
    return result?.serverInfo ?? {};
  }

  /** Every tool, following pagination to the end. */
  async listTools(): Promise<McpTool[]> {
    await this.connect();

    const tools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const page = (await this.send(
        "tools/list",
        cursor ? { cursor } : {},
      )) as { tools?: McpTool[]; nextCursor?: string };

      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
      // A server that keeps returning the same cursor would loop forever.
    } while (cursor && tools.length < 5_000);

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.send("tools/call", { name, arguments: args });
  }
}

/**
 * Pulls the useful payload out of a tool result.
 *
 * MCP wraps results in `content` blocks aimed at a model. Structured data
 * arrives either as `structuredContent` or as JSON inside a text block, so both
 * are unwrapped before the caller sees them.
 */
export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;

  const envelope = result as {
    structuredContent?: unknown;
    content?: { type?: string; text?: string }[];
  };

  if (envelope.structuredContent !== undefined) return envelope.structuredContent;

  const text = envelope.content
    ?.filter((block) => block?.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");

  if (!text) return result;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
