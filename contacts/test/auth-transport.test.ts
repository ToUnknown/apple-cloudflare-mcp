import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const origin = "https://contacts.example.invalid";
const password = "synthetic-owner-password-123456789";
let mf: Miniflare;
const dispatch = (url: string | URL, init: RequestInit = {}) =>
  mf.dispatchFetch(url, { ...init, redirect: "manual" });
const headers = { "content-type": "application/json" };
async function post(
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
) {
  return dispatch(origin + path, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });
}
async function register() {
  const r = await post("/register", {
    client_name: "Synthetic Test",
    redirect_uris: ["https://client.example.invalid/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string };
}
async function login(clientId: string) {
  const verifier = "a".repeat(43);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = Buffer.from(hash).toString("base64url");
  const url = new URL(origin + "/authorize");
  for (const [k, v] of Object.entries({
    client_id: clientId,
    redirect_uri: "https://client.example.invalid/callback",
    response_type: "code",
    scope: "contacts",
    resource: origin + "/mcp",
    state: "synthetic",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(k, v);
  const response = await dispatch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://client.example.invalid;");
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return { handle: handle!, cookie, url, verifier };
}
describe("real Worker OAuth and MCP transport (synthetic local KV)", () => {
  beforeAll(() => {
    execFileSync("npm", ["run", "build"], { stdio: "pipe" });
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: readFileSync("dist/index.js", "utf8"),
        compatibilityDate: "2026-10-14",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          PUBLIC_ORIGIN: origin,
          ICLOUD_USERNAME: "owner@example.invalid",
          ICLOUD_APP_PASSWORD: "synthetic-app-password",
          OWNER_PASSWORD: password,
        },
      }),
    );
  }, 30_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  it("advertises OAuth resource and rejects unauthenticated MCP", async () => {
    const r = await post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(
      "oauth-protected-resource",
    );
    const metadata = await dispatch(
      origin + "/.well-known/oauth-protected-resource/mcp",
    );
    expect(await metadata.json()).toMatchObject({ resource: origin + "/mcp" });
  });
  it("allows ChatGPT through to authentication but rejects lookalike and null origins", async () => {
    expect((await post("/mcp", {}, { Origin: "https://chatgpt.com" })).status).toBe(401);
    for (const value of ["https://chatgpt.com.attacker.invalid", "null"]) {
      expect((await post("/mcp", {}, { Origin: value })).status).toBe(403);
    }
  });
  it("rejects malicious origin and missing PKCE", async () => {
    expect(
      (await post("/mcp", {}, { Origin: "https://evil.invalid" })).status,
    ).toBe(403);
    const { client_id } = await register();
    const url = new URL(origin + "/authorize");
    for (const [k, v] of Object.entries({
      client_id,
      redirect_uri: "https://client.example.invalid/callback",
      response_type: "code",
      scope: "contacts",
    }))
      url.searchParams.set(k, v);
    expect((await dispatch(url)).status).toBe(400);
  });
  it("enforces owner password, browser binding and form origin before granting access", async () => {
    const { client_id } = await register();
    const loginData = await login(client_id);
    const body = new URLSearchParams({
      handle: loginData.handle,
      password,
      decision: "approve",
    }).toString();
    expect(
      (
        await dispatch(origin + "/authorize", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            Origin: "https://evil.invalid",
            Cookie: loginData.cookie,
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch(origin + "/authorize", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            Origin: origin,
          },
          body,
        })
      ).status,
    ).toBe(400);
    const wrong = await login(client_id);
    const wrongBody = new URLSearchParams({
      handle: wrong.handle,
      password: "wrong",
      decision: "approve",
    }).toString();
    expect(
      (
        await dispatch(origin + "/authorize", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            Origin: origin,
            Cookie: wrong.cookie,
          },
          body: wrongBody,
        })
      ).status,
    ).toBe(403);
  });
  it("completes PKCE and calls standard MCP tools/list with OAuth bearer token", async () => {
    const { client_id } = await register();
    const data = await login(client_id);
    const body = new URLSearchParams({
      handle: data.handle,
      password,
      decision: "approve",
    }).toString();
    const approved = await dispatch(origin + "/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Origin: origin,
        Cookie: data.cookie,
      },
      body,
    });
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("synthetic");
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id,
      code: callback.searchParams.get("code")!,
      redirect_uri: "https://client.example.invalid/callback",
      code_verifier: data.verifier,
      resource: origin + "/mcp",
    });
    const tokenResponse = await dispatch(origin + "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as { access_token: string };
    expect(token.access_token).toBeTruthy();
    const bearer = {
      Authorization: "Bearer " + token.access_token,
      Accept: "application/json, text/event-stream",
    };
    const init = await post(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "synthetic", version: "1" },
        },
      },
      bearer,
    );
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({
      result: { serverInfo: { name: "icloud-contacts" } },
    });
    const listed = await post(
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      bearer,
    );
    expect(listed.status).toBe(200);
    const tools = (await listed.json()) as {
      result: {
        tools: {
          name: string;
          annotations: { destructiveHint: boolean; readOnlyHint: boolean };
        }[];
      };
    };
    expect(tools.result.tools.map((t) => t.name)).toContain(
      "change_group_members",
    );
    expect(
      tools.result.tools.find((t) => t.name === "delete_contact")?.annotations
        .destructiveHint,
    ).toBe(true);
    expect(
      tools.result.tools.find((t) => t.name === "read_contact")?.annotations
        .readOnlyHint,
    ).toBe(true);
    expect(JSON.stringify(tools)).not.toContain("synthetic-app-password");
    const largeRequest = await post(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: { _meta: { padding: "x".repeat(2 * 1024 * 1024 + 1) } },
      },
      bearer,
    );
    expect(largeRequest.status).toBe(200);
    expect(await largeRequest.json()).toHaveProperty("result.tools");
    expect(
      (
        await dispatch(origin + "/authorize", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            Origin: origin,
            Cookie: data.cookie,
          },
          body,
        })
      ).status,
    ).toBe(400);
  });
});
