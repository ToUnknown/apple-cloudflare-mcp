import {
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { handleMailMcp } from "./event-route";
import { authorize, originAllowed } from "./auth";

import type { AppEnv } from "./types";
export { SendReceipt } from "./durable";
export { MailEvents } from "./event-durable";
export function providerOptions(env: AppEnv): OAuthProviderOptions<AppEnv> {
  return {
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}/mcp`,
      authorization_servers: [env.PUBLIC_ORIGIN],
      resource_name: "iCloud Mail",
    },
    clientIdMetadataDocumentEnabled: true,
    requiredScopes: ["mail"],
    scopesSupported: ["mail", "offline_access"],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
    apiHandler: {
      async fetch(request, bindings, ctx) {
        if (new URL(request.url).pathname !== "/mcp")
          return new Response("Not found", { status: 404 });
        if (!originAllowed(request, bindings.PUBLIC_ORIGIN))
          return new Response("Forbidden origin", { status: 403 });
        const props = ctx.props as
          { userId?: string; scope?: string[] } | undefined;
        if (props?.userId !== "owner" || !props.scope?.includes("mail"))
          return new Response("Forbidden", { status: 403 });
        const token = request.headers.get("Mcp-Method")?.startsWith("events/") && bindings.OAUTH_PROVIDER
          ? await bindings.OAUTH_PROVIDER.unwrapToken(
              request.headers.get("Authorization")?.replace(/^Bearer /i, "") ??
                "",
            )
          : null;
        let principal;
        if (token && bindings.OAUTH_PROVIDER) {
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const grants = await bindings.OAUTH_PROVIDER.listUserGrants(
              token.userId,
              { limit: 100, cursor },
            );
            const grant = grants.items.find((g) => g.id === token.grantId);
            if (grant) {
              principal = {
                userId: token.userId,
                clientId: grant.clientId,
                grantId: token.grantId,
              };
              break;
            }
            if (!grants.cursor) break;
            cursor = grants.cursor;
          }
        }
        return handleMailMcp(request, bindings, principal);
      },
    },
    defaultHandler: {
      fetch(request, bindings) {
        if (
          new URL(request.url).pathname === "/authorize" &&
          bindings.OAUTH_PROVIDER
        )
          return authorize(request, bindings, bindings.OAUTH_PROVIDER);
        return Promise.resolve(
          new Response(
            "iCloud Mail MCP. Connect an OAuth MCP client at /mcp.",
            { headers: { "Content-Type": "text/plain" } },
          ),
        );
      },
    },
  };
}
export function provider(env: AppEnv) {
  return new OAuthProvider<AppEnv>(providerOptions(env));
}
export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let canonical: URL;
    try {
      canonical = new URL(env.PUBLIC_ORIGIN);
    } catch {
      return new Response("Configure PUBLIC_ORIGIN.", { status: 503 });
    }
    if (
      canonical.origin !== env.PUBLIC_ORIGIN ||
      (canonical.protocol !== "https:" &&
        canonical.hostname !== "localhost" &&
        canonical.hostname !== "127.0.0.1")
    )
      return new Response("Invalid PUBLIC_ORIGIN.", { status: 503 });
    if (new URL(request.url).origin !== canonical.origin)
      return new Response("Unexpected host.", { status: 400 });
    if (!originAllowed(request, canonical.origin))
      return new Response("Forbidden origin.", { status: 403 });
    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 4 * 1024 * 1024)
      return new Response("Request too large", { status: 413 });
    // Bound requests even when a client omits Content-Length. Never read unbounded JSON/form bodies.
    let bounded = request;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            return new Response("Request too large", { status: 413 });
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bounded = new Request(request, { body });
    }
    try {
      return await provider(env).fetch(bounded, env, ctx);
    } catch {
      return new Response("Service temporarily unavailable.", { status: 503 });
    }
  },
};
