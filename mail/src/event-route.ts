import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { createServer } from "./tools";
import { definition } from "./events";
import type { Principal } from "./events";
import type { AppEnv } from "./types";
export async function handleMailMcp(
  request: Request,
  env: AppEnv,
  principal?: Principal,
): Promise<Response> {
  let input:
    | {
        jsonrpc?: string;
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      }
    | undefined;
  if (request.method === "POST") {
    try {
      input = await request.clone().json();
    } catch {
      /* SDK returns parse error */
    }
  }
  const eventMethod =
    typeof input?.method === "string" && input.method.startsWith("events/");
  if (eventMethod) {
    const reply = (payload: unknown) =>
      Response.json(
        { jsonrpc: "2.0", id: input?.id ?? null, ...(payload as object) },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (input?.jsonrpc !== "2.0" || input.id === undefined)
      return reply({
        error: {
          code: -32600,
          message: "Event methods require a JSON-RPC request",
        },
      });
    const meta = input.params?._meta as Record<string, unknown> | undefined;
    if (
      request.headers.get("Mcp-Method") !== input.method ||
      request.headers.get("MCP-Protocol-Version") !== "2026-07-28" ||
      meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" ||
      !meta?.["io.modelcontextprotocol/clientInfo"] ||
      !meta?.["io.modelcontextprotocol/clientCapabilities"]
    )
      return reply({
        error: {
          code: -32600,
          message: "Events require MCP 2026-07-28 request metadata",
        },
      });
    if (!principal)
      return reply({
        error: {
          code: -32024,
          message: "Authenticated mail principal required",
        },
      });
    if (String(env.MAIL_EVENTS_ENABLED) !== "true")
      return reply({
        error: {
          code: -32024,
          message: "Mail events are not enabled by the owner",
        },
      });
    if (
      input.method !== "events/list" &&
      request.headers.get("Mcp-Name") !== input.params?.name
    )
      return reply({
        error: {
          code: -32020,
          message: "Mcp-Name header must match params.name",
        },
      });
    if (input.method === "events/list")
      return reply({
        result: { resultType: "complete", events: [definition] },
      });
    if (
      input.method !== "events/subscribe" &&
      input.method !== "events/unsubscribe"
    )
      return reply({
        error: { code: -32601, message: "Unsupported event method" },
      });
    const response = await env.MAIL_EVENTS.get(
      env.MAIL_EVENTS.idFromName("owner-mail-events"),
    ).fetch("https://internal/events", {
      method: "POST",
      body: JSON.stringify({
        method: input.method,
        params: input.params,
        principal,
      }),
    });
    const outcome = (await response.json()) as {
      result?: Record<string, unknown>;
      error?: unknown;
    };
    return reply(
      outcome.error
        ? { error: outcome.error }
        : { result: { resultType: "complete", ...outcome.result } },
    );
  }
  if (
    await isLegacyRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "POST" ? await request.clone().text() : undefined,
      }),
    )
  ) {
    const server = createServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
  const response = await createMcpHandler(() => createServer(env), {
    responseMode: "json",
  }).fetch(request);
  if (
    input?.method === "server/discover" &&
    String(env.MAIL_EVENTS_ENABLED) === "true" &&
    response.ok
  ) {
    const body = (await response.json()) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    if (body.result)
      body.result.capabilities = { ...body.result.capabilities, events: {} };
    return Response.json(body, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return response;
}
