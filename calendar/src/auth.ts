import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { timingSafeEqual } from "node:crypto";
import { boundedText } from "./caldav";
import { mcpResponse } from "./mcp";
import type { CalendarEnv } from "./env";
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(details: ConsentDescription, handle: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>iCloud Calendar approval</title><body><h1>Allow ${esc(details.clientName)}?</h1><p>This gives the app access to read and modify your iCloud calendars and events.</p><p>Access returns to <strong>${esc(details.redirectHost)}</strong>.</p><p>${details.clientDomain ? `Client domain: ${esc(details.clientDomain)}` : "This client name is self-reported."}</p>${details.redirectIsLoopback ? "<p>This sends access to an app on your computer. Continue only if you started this sign-in.</p>" : ""}<p>Scopes: ${details.scope.map(esc).join(", ")}</p><form method="post"><input type="hidden" name="handle" value="${esc(handle)}"><label>Owner password <input name="password" type="password" autocomplete="current-password" required maxlength="512"></label><p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p></form></body></html>`;
}
async function ownerPassword(
  input: string,
  expected: string,
): Promise<boolean> {
  if (!expected || expected.length < 32 || input.length > 512) return false;
  const bytes = new TextEncoder();
  const a = await crypto.subtle.digest("SHA-256", bytes.encode(input)),
    b = await crypto.subtle.digest("SHA-256", bytes.encode(expected));
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
}
export async function authorization(
  request: Request,
  env: CalendarEnv,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/authorize")
    return new Response("iCloud Calendar MCP. Connect at /mcp.", {
      headers: { "Content-Type": "text/plain" },
    });
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (
        !authRequest.codeChallenge ||
        authRequest.codeChallengeMethod !== "S256"
      )
        return new Response("S256 PKCE is required", { status: 400 });
      if (
        !authRequest.scope.includes("calendar") ||
        authRequest.scope.some(
          (s) => !["calendar", "offline_access"].includes(s),
        )
      )
        return new Response("Request the calendar scope", { status: 400 });
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Cache-Control", "no-store");
      consent.headers.set("Referrer-Policy", "no-referrer");
      consent.headers.set(
        "Content-Security-Policy",
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      return new Response(page(details, consent.handle), {
        headers: consent.headers,
      });
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("origin") !== env.PUBLIC_ORIGIN)
      return new Response("Origin refused", { status: 403 });
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return new Response("Invalid form", { status: 415 });
    const text = await boundedText(new Response(request.body), 4096);
    const form = new URLSearchParams(text),
      handle = form.get("handle") ?? "";
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (
      form.get("decision") !== "approve" ||
      !(await ownerPassword(form.get("password") ?? "", env.OWNER_PASSWORD))
    )
      return new Response("Owner approval failed", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { label: "iCloud Calendar owner" },
      scope: approved.request.scope,
      props: { userId: "owner" },
    });
    approved.headers.set("Location", redirectTo);
    approved.headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return new Response(
        "Invalid or expired authorization request; restart sign-in",
        { status: 400 },
      );
    return new Response("Authorization unavailable", { status: 503 });
  }
}
export function provider(origin: string): OAuthProvider<CalendarEnv> {
  return new OAuthProvider<CalendarEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, context) {
        const ctx = context as OAuthResourceContext<{ userId: string }>;
        if (
          ctx.props?.userId !== "owner" ||
          !ctx.auth.scope.includes("calendar")
        )
          return new Response("Insufficient scope", { status: 403 });
        return mcpResponse(request, env);
      },
    },
    defaultHandler: { fetch: authorization },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["calendar", "offline_access"],
    requiredScopes: ["calendar"],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "iCloud Calendar",
    },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
    onError: () => undefined,
  });
}
