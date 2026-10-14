export { CreationReceipt } from "./creation-durable";
import OAuthProvider, {
  getOAuthApi,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CardDAV, boundedText } from "./carddav";
import { createServer } from "./tools";
import { authorize, allowedOrigin, type AppEnv } from "./auth";
export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      const origin = new URL(env.PUBLIC_ORIGIN);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== env.PUBLIC_ORIGIN ||
        url.origin !== origin.origin
      )
        return new Response("Set PUBLIC_ORIGIN to this Worker HTTPS origin", {
          status: 503,
        });
      if (!allowedOrigin(request, origin.origin))
        return new Response("Invalid origin", { status: 403 });
      if (
        !env.OWNER_PASSWORD ||
        env.OWNER_PASSWORD.length < 32 ||
        !env.ICLOUD_USERNAME ||
        !env.ICLOUD_APP_PASSWORD
      )
        return new Response(
          "Required Worker secrets are missing or owner password is too short",
          { status: 503 },
        );
      const options: OAuthProviderOptions<AppEnv> = {
        apiRoute: "/mcp",
        apiHandler: {
          async fetch(req, bindings, context) {
            const tokenContext = context as ExecutionContext & {
              auth?: { scope: string[]; userId?: string };
            };
            if (
              !tokenContext.auth?.scope.includes("contacts") ||
              tokenContext.auth.userId !== "owner" ||
              !context.props ||
              typeof context.props !== "object" ||
              !("owner" in context.props) ||
              context.props.owner !== true
            )
              return new Response("Insufficient scope", { status: 403 });
            if (new URL(req.url).pathname !== "/mcp")
              return new Response("Not found", { status: 404 });
            if (req.method === "GET" || req.method === "DELETE")
              return new Response("Stateless MCP supports POST only", {
                status: 405,
                headers: { Allow: "POST" },
              });
            if (req.method !== "POST")
              return new Response("Method not allowed", { status: 405 });
            let parsedBody: unknown;
            try {
              parsedBody = JSON.parse(
                await boundedText(new Response(req.body), 16 * 1024 * 1024),
              );
            } catch {
              return new Response("Invalid or oversized JSON body", {
                status: 400,
              });
            }
            const server = createServer(
              new CardDAV(
                bindings.ICLOUD_USERNAME,
                bindings.ICLOUD_APP_PASSWORD,
              ),
              (operationId) =>
                bindings.CREATION_RECEIPTS.getByName(operationId),
            );
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: true,
              maxRequestBodySize: 16 * 1024 * 1024,
            });
            await server.connect(transport);
            try {
              return await transport.handleRequest(req, { parsedBody });
            } finally {
              await server.close();
            }
          },
        },
        defaultHandler: {
          fetch(req, bindings) {
            return authorize(req, bindings, getOAuthApi(options, bindings));
          },
        },
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: ["contacts"],
        requiredScopes: ["contacts"],
        resourceMetadata: {
          resource: origin.origin + "/mcp",
          authorization_servers: [origin.origin],
          resource_name: "iCloud Contacts",
        },
        accessTokenTTL: 3600,
        refreshTokenTTL: 30 * 24 * 3600,
      };
      const provider = new OAuthProvider<AppEnv>(options);
      return await provider.fetch(request, env, ctx);
    } catch {
      return new Response("Contacts MCP request failed", { status: 500 });
    }
  },
};
