import { timingSafeEqual } from "node:crypto";
import {
  AuthorizationError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./types";
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        s
      ]!,
  );
}
export function passwordMatches(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function originAllowed(request: Request, canonical: string): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === canonical;
}
function error(message: string, status = 400) {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
export async function authorize(
  request: Request,
  env: AppEnv,
  oauth: OAuthHelpers,
): Promise<Response> {
  if (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < 32)
    return error(
      "Configure OWNER_PASSWORD with at least 32 random characters.",
      503,
    );
  try {
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      // Require S256 for every client, including confidential clients.
      if (!auth.codeChallenge || auth.codeChallengeMethod !== "S256")
        return error("OAuth authorization requires S256 PKCE.");
      if (auth.scope.some((s) => s !== "mail" && s !== "offline_access"))
        return error("Unsupported scope. Request mail.");
      const transaction = await oauth.beginConsent(auth);
      const description = await oauth.describeConsent(auth);
      const headers = transaction.headers;
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const client = escapeHtml(description.clientName);
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approve iCloud Mail</title><style>body{font:16px system-ui;max-width:560px;margin:64px auto;padding:24px}input,button{font:inherit;margin:8px 0;padding:10px}input{width:90%}</style><h1>Approve iCloud Mail</h1><p>Client: <strong>${client}</strong></p><p>Redirect: ${escapeHtml(auth.redirectUri)}</p><p>Access: read, change, delete and send mail for the configured owner. Requested scopes: ${escapeHtml(auth.scope.join(" ") || "mail")}.</p><p>Only approve a client you intended to connect. Enter the deployment owner's password.</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(transaction.handle)}"><input name="password" type="password" autocomplete="current-password" required maxlength="512" aria-label="Owner password"><br><button name="decision" value="allow">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></form></html>`,
        { headers },
      );
    }
    if (request.method !== "POST") return error("Method not allowed", 405);
    // Browser form POST must present the exact canonical origin. Library also binds a single-use consent handle to its HttpOnly cookie.
    if (
      request.headers.get("Origin") !== env.PUBLIC_ORIGIN ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    )
      return error("Invalid approval origin.", 403);
    if (
      !request.headers
        .get("Content-Type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return error("Expected an approval form.", 415);
    const text = await request.text();
    if (text.length > 8192) return error("Approval form too large.", 413);
    const form = new URLSearchParams(text);
    const handle = form.get("handle") ?? "";
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (form.get("decision") !== "allow")
      return error("Invalid approval decision.");
    const attempts = await env.SEND_RECEIPTS.get(
      env.SEND_RECEIPTS.idFromName("owner-approval-throttle"),
    ).fetch("https://internal/attempt", { method: "POST" });
    if (!attempts.ok)
      return error("Approval rate limit exceeded; wait five minutes.", 429);
    if (!passwordMatches(form.get("password") ?? "", env.OWNER_PASSWORD))
      return error(
        "Owner authentication failed. Restart the connection to try again.",
        403,
      );
    const approved = await oauth.approveConsent(request, handle);
    if (approved.request.codeChallengeMethod !== "S256")
      return error("S256 PKCE required.");
    const scope = approved.request.scope.includes("mail")
      ? approved.request.scope
      : [...approved.request.scope, "mail"];
    const result = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      scope,
      metadata: { service: "icloud-mail" },
      props: { userId: "owner", scope },
    });
    approved.headers.set("Location", result.redirectTo);
    approved.headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (cause) {
    if (cause instanceof AuthorizationError)
      return error(
        "Invalid, expired or already-used OAuth authorization request. Restart the connection.",
      );
    return error(
      "Authorization could not be completed. Restart the connection.",
      503,
    );
  }
}
