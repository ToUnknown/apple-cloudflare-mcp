import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { boundedText } from "./carddav";
export interface Secrets {
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
  OWNER_PASSWORD: string;
  PUBLIC_ORIGIN: string;
}
export type AppEnv = Omit<Cloudflare.Env, "PUBLIC_ORIGIN"> & Secrets;
const html = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function passwordMatches(
  input: string,
  expected: string,
): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  let diff = 0;
  const aa = new Uint8Array(a),
    bb = new Uint8Array(b);
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
export function allowedOrigin(request: Request, origin: string): boolean {
  const supplied = request.headers.get("Origin");
  return !supplied || supplied === origin || supplied === "https://chatgpt.com";
}
export async function authorize(
  request: Request,
  env: AppEnv,
  oauth: OAuthHelpers,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/authorize")
    return new Response("iCloud Contacts MCP: connect /mcp using OAuth.", {
      status: 404,
    });
  try {
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      if (
        auth.codeChallengeMethod !== "S256" ||
        !auth.codeChallenge ||
        !/^[A-Za-z0-9_-]{43}$/.test(auth.codeChallenge)
      )
        return new Response("S256 PKCE is required", { status: 400 });
      if (auth.scope.some((s) => s !== "contacts"))
        return new Response("Only contacts scope is supported", {
          status: 400,
        });
      const client = await oauth.describeConsent(auth);
      const transaction = await oauth.beginConsent(auth);
      const headers = transaction.headers;
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      headers.set("Referrer-Policy", "same-origin");
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approve Contacts access</title><h1>Approve iCloud Contacts access</h1><p>${html(client.clientName)} requests permission to read, create, edit and permanently delete this owner's contacts and lists.</p><p>Redirect: ${html(client.redirectHost)}${client.redirectIsLoopback ? " (local application)" : ""}</p><p>Scope: contacts</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${html(transaction.handle)}"><label>Owner password <input type="password" name="password" required autocomplete="current-password" maxlength="1024"></label><button name="decision" value="approve">Approve access</button><button name="decision" value="deny" formnovalidate>Decline</button></form></html>`,
        { headers },
      );
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    if (
      request.headers.get("Origin") !== env.PUBLIC_ORIGIN ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    )
      return new Response("Invalid form origin", { status: 403 });
    if (
      !request.headers
        .get("Content-Type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return new Response("Invalid form content type", { status: 415 });
    const body = await boundedText(new Response(request.body), 4096);
    const form = new URLSearchParams(body);
    const handle = form.get("handle") ?? "";
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      denied.headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (
      form.get("decision") !== "approve" ||
      !(await passwordMatches(form.get("password") ?? "", env.OWNER_PASSWORD))
    )
      return new Response(
        "Approval failed. Open the authorization link again.",
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    const approved = await oauth.approveConsent(request, handle, {
      scope: ["contacts"],
    });
    if (
      approved.request.codeChallengeMethod !== "S256" ||
      !approved.request.codeChallenge
    )
      return new Response("S256 PKCE is required", { status: 400 });
    const completed = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      scope: ["contacts"],
      metadata: { service: "icloud-contacts" },
      props: { owner: true },
      revokeExistingGrants: false,
    });
    approved.headers.set("Location", completed.redirectTo);
    approved.headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers: approved.headers });
  } catch {
    return new Response("Invalid or expired authorization request", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
