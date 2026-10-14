import { test, expect, afterAll, beforeAll } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { CalendarEnv } from "../src/env";

const instances = new Map<CalendarEnv, Miniflare>();
beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--outdir",
      "dist",
    ],
    { stdio: "pipe" },
  );
}, 30000);
afterAll(async () => {
  await Promise.all(
    [...instances.values()].map((instance) => instance.dispose()),
  );
});
const worker = {
  async fetch(request: Request, env: CalendarEnv, _ctx: ExecutionContext) {
    let instance = instances.get(env);
    if (!instance) {
      instance = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          scriptPath: resolve("dist/index.js"),
          compatibilityDate: "2026-10-14",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          kvNamespaces: ["OAUTH_KV"],
          bindings: {
            PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
            ICLOUD_USERNAME: env.ICLOUD_USERNAME,
            ICLOUD_APP_PASSWORD: env.ICLOUD_APP_PASSWORD,
            OWNER_PASSWORD: env.OWNER_PASSWORD,
          },
        }),
      );
      instances.set(env, instance);
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    return instance.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
      redirect: "manual",
    });
  },
};
const origin = "https://calendar.example.test";
const makeEnv = () =>
  ({
    PUBLIC_ORIGIN: origin,
    ICLOUD_USERNAME: "synthetic@example.invalid",
    ICLOUD_APP_PASSWORD: "dummy",
    OWNER_PASSWORD: "synthetic-owner-password-at-least-32-characters",
    OAUTH_KV: null,
  }) as unknown as CalendarEnv;
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as ExecutionContext;
const request = (url: string, init?: RequestInit) =>
  new Request(`${origin}${url}`, init);
async function oauthStart(env: CalendarEnv) {
  const registered = await worker.fetch(
    request("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<synthetic client>",
        redirect_uris: ["https://client.example.test/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    env,
    ctx,
  );
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const verifier = "a".repeat(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Buffer.from(digest).toString("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://client.example.test/callback",
    response_type: "code",
    scope: "calendar offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "synthetic-state",
    resource: `${origin}/mcp`,
  });
  const auth = await worker.fetch(request(`/authorize?${params}`), env, ctx);
  expect(auth.status).toBe(200);
  const html = await auth.text();
  expect(html).toContain("&#60;synthetic client&#62;");
  const handle = html.match(/name="handle" value="([^"]+)"/)![1];
  const cookie = auth.headers.get("set-cookie")!.split(";")[0];
  return { client, verifier, params, handle, cookie };
}
function form(handle: string, password: string, decision = "approve") {
  return new URLSearchParams({ handle, password, decision }).toString();
}
const headers = (cookie: string, requestOrigin = origin) => ({
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: requestOrigin,
  Cookie: cookie,
});
test("unauthenticated MCP advertises protected-resource discovery", async () => {
  const response = await worker.fetch(
    request("/mcp", { method: "POST", body: "{}" }),
    makeEnv(),
    ctx,
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    "oauth-protected-resource",
  );
  const metadata = await worker.fetch(
    request("/.well-known/oauth-protected-resource/mcp"),
    makeEnv(),
    ctx,
  );
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({ resource: `${origin}/mcp` });
});
test("password, origin and browser-bound consent failures cannot issue access", async () => {
  const env = makeEnv();
  const { handle, cookie } = await oauthStart(env);
  const badOrigin = await worker.fetch(
    request("/authorize", {
      method: "POST",
      headers: headers(cookie, "https://attacker.test"),
      body: form(handle, env.OWNER_PASSWORD),
    }),
    env,
    ctx,
  );
  expect(badOrigin.status).toBe(403);
  const badPassword = await worker.fetch(
    request("/authorize", {
      method: "POST",
      headers: headers(cookie),
      body: form(handle, "bad-password"),
    }),
    env,
    ctx,
  );
  expect(badPassword.status).toBe(403);
  const missingCookie = await worker.fetch(
    request("/authorize", {
      method: "POST",
      headers: headers(""),
      body: form(handle, env.OWNER_PASSWORD),
    }),
    env,
    ctx,
  );
  expect(missingCookie.status).toBe(400);
});
test("PKCE owner approval exchanges a code and reaches real stateless MCP initialize and tools/list", async () => {
  const env = makeEnv();
  const { client, verifier, handle, cookie } = await oauthStart(env);
  const approval = await worker.fetch(
    request("/authorize", {
      method: "POST",
      headers: headers(cookie),
      body: form(handle, env.OWNER_PASSWORD),
    }),
    env,
    ctx,
  );
  expect(approval.status).toBe(302);
  const redirect = new URL(approval.headers.get("location")!);
  expect(redirect.searchParams.get("state")).toBe("synthetic-state");
  const code = redirect.searchParams.get("code")!;
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: "https://client.example.test/callback",
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  });
  const token = await worker.fetch(
    request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    }),
    env,
    ctx,
  );
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as {
    access_token: string;
    refresh_token: string;
  };
  expect(tokens.refresh_token).toBeTruthy();
  const mcpHeaders = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const initialize = await worker.fetch(
    request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "synthetic", version: "1" },
        },
      }),
    }),
    env,
    ctx,
  );
  expect(initialize.status).toBe(200);
  expect(await initialize.json()).toMatchObject({
    result: { serverInfo: { name: "icloud-calendar" } },
  });
  const listed = await worker.fetch(
    request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    }),
    env,
    ctx,
  );
  expect(listed.status).toBe(200);
  const tools = (await listed.json()) as {
    result: { tools: { name: string }[] };
  };
  expect(tools.result.tools.some((t) => t.name === "events_update")).toBe(true);
  expect(tools.result.tools).toHaveLength(13);
  const replay = await worker.fetch(
    request("/authorize", {
      method: "POST",
      headers: headers(cookie),
      body: form(handle, env.OWNER_PASSWORD),
    }),
    env,
    ctx,
  );
  expect(replay.status).toBe(400);
  const codeReplay = await worker.fetch(
    request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    }),
    env,
    ctx,
  );
  expect(codeReplay.status).toBe(400);
});
test("authorization requests require S256 and deny preserves validated state", async () => {
  const env = makeEnv();
  const started = await oauthStart(env);
  const noPKCE = new URLSearchParams(started.params);
  noPKCE.delete("code_challenge");
  noPKCE.delete("code_challenge_method");
  expect(
    (await worker.fetch(request(`/authorize?${noPKCE}`), env, ctx)).status,
  ).toBe(400);
  const denied = await worker.fetch(
    request("/authorize", {
      method: "POST",
      headers: headers(started.cookie),
      body: form(started.handle, "", "deny"),
    }),
    env,
    ctx,
  );
  expect(denied.status).toBe(302);
  expect(
    new URL(denied.headers.get("location")!).searchParams.get("error"),
  ).toBe("access_denied");
});
