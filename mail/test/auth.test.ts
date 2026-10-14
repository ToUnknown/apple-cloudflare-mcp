import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
test(
  "workerd: OAuth PKCE, owner consent/CSRF, authenticated stateless MCP",
  { timeout: 60000 },
  async () => {
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    const password = "synthetic-test-owner-password-32-characters";
    await mkdir(".wrangler", { recursive: true });
    const state = await mkdtemp(path.resolve(".wrangler/mail-auth-test-"));
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--local",
        "--port",
        String(port),
        "--persist-to",
        state,
        "--var",
        `PUBLIC_ORIGIN:${base}`,
        "--var",
        `OWNER_PASSWORD:${password}`,
        "--var",
        "ICLOUD_USERNAME:owner@example.invalid",
        "--var",
        "ICLOUD_APP_PASSWORD:synthetic-only",
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          BROWSER: "none",
        },
      },
    );
    let logs = "";
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          const r = await fetch(base);
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {}
        await setTimeout(100);
      }
      assert.ok(ready, `Worker failed to start: ${logs.slice(-3000)}`);
      assert.equal(
        (
          await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
              Origin: "https://attacker.invalid",
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
        403,
      );
      const metadata = (await (
        await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
      ).json()) as { resource: string; authorization_servers: string[] };
      assert.equal(metadata.resource, `${base}/mcp`);
      assert.deepEqual(metadata.authorization_servers, [base]);
      const registration = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "<script>synthetic</script>",
          redirect_uris: [
            "https://chatgpt.com/connector_platform/oauth_redirect",
          ],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      assert.equal(registration.status, 201);
      const client = (await registration.json()) as { client_id: string };
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "https://chatgpt.com/connector_platform/oauth_redirect",
        response_type: "code",
        scope: "mail offline_access",
        state: "synthetic-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${base}/mcp`,
      });
      const noPkce = new URLSearchParams(params);
      noPkce.delete("code_challenge");
      noPkce.delete("code_challenge_method");
      assert.equal((await fetch(`${base}/authorize?${noPkce}`)).status, 400);
      const page = await fetch(`${base}/authorize?${params}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.doesNotMatch(html, /<script>/);
      assert.match(html, /&lt;script&gt;/);
      assert.match(
        page.headers.get("Content-Security-Policy") ?? "",
        /frame-ancestors 'none'/,
      );
      const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
      assert.ok(handle);
      const cookie = page.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      const body = new URLSearchParams({
        handle,
        password,
        decision: "allow",
      }).toString();
      const post = (origin = base, cookies = cookie) =>
        fetch(`${base}/authorize`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: origin,
            Cookie: cookies,
          },
          body,
        });
      assert.equal((await post("https://attacker.invalid")).status, 403);
      assert.equal((await post(base, "")).status, 400);
      const wrongPassword = await fetch(`${base}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: base,
          Cookie: cookie,
        },
        body: new URLSearchParams({
          handle,
          password: "wrong",
          decision: "allow",
        }),
      });
      assert.equal(wrongPassword.status, 403);
      const grant = await post();
      assert.equal(grant.status, 302);
      const callback = new URL(grant.headers.get("Location")!);
      assert.equal(callback.searchParams.get("state"), "synthetic-state");
      const code = callback.searchParams.get("code");
      assert.ok(code);
      assert.equal(
        (await post()).status,
        400,
        "consent handle must be single-use",
      );
      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: "https://chatgpt.com/connector_platform/oauth_redirect",
        code_verifier: verifier,
        resource: `${base}/mcp`,
      });
      const badParams = new URLSearchParams(tokenParams);
      badParams.set("code_verifier", "x".repeat(43));
      assert.equal(
        (await fetch(`${base}/token`, { method: "POST", body: badParams }))
          .status,
        400,
      );
      const tokenResponse = await fetch(`${base}/token`, {
        method: "POST",
        body: tokenParams,
      });
      assert.equal(tokenResponse.status, 200);
      const token = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
      };
      assert.ok(token.access_token);
      assert.ok(token.refresh_token);
      const rpc = (method: string, params?: unknown) =>
        fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      const initialize = await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      });
      assert.equal(initialize.status, 200);
      const tools = (await (await rpc("tools/list")).json()) as {
        result: {
          tools: { name: string; annotations: { readOnlyHint: boolean } }[];
        };
      };
      assert.equal(tools.result.tools.length, 16);
      assert.ok(tools.result.tools.find((t) => t.name === "mail_send"));
      assert.equal(
        tools.result.tools.find((t) => t.name === "mail_delete")?.annotations
          .readOnlyHint,
        false,
      );
      const identitiesResponse = await rpc("tools/call", {
        name: "mail_identities",
        arguments: {},
      });
      const identitiesResult = (await identitiesResponse.json()) as {
        result: { content: { text: string }[] };
      };
      assert.deepEqual(JSON.parse(identitiesResult.result.content[0].text), {
        preferred: "owner@example.invalid",
        allowed: ["owner@example.invalid"],
      });
      const blockedId = "cabf81de-13c1-46d8-b779-af7e9ad7c829";
      const blockedResponse = await rpc("tools/call", {
        name: "mail_send",
        arguments: {
          operationId: blockedId,
          message: {
            from: "attacker@example.invalid",
            to: ["friend@example.invalid"],
            text: "Must never reach SMTP.",
          },
        },
      });
      const blocked = (await blockedResponse.json()) as {
        result: { content: { text: string }[] };
      };
      assert.match(
        JSON.parse(blocked.result.content[0].text).error,
        /Sender is not allowed/,
      );
      const blockedReceiptResponse = await rpc("tools/call", {
        name: "mail_send_receipt",
        arguments: { operationId: blockedId },
      });
      const blockedReceipt = (await blockedReceiptResponse.json()) as {
        result: { content: { text: string }[] };
      };
      assert.equal(
        JSON.parse(blockedReceipt.result.content[0].text).status,
        "not_found",
        "invalid sender must be rejected before reserving or submitting SMTP",
      );
      const receipt = await rpc("tools/call", {
        name: "mail_send_receipt",
        arguments: { operationId: "6b7d242f-170d-4857-afc0-7c28c8a99732" },
      });
      assert.equal(receipt.status, 200);
      const receiptJson = (await receipt.json()) as {
        result: { content: { text: string }[] };
      };
      assert.equal(
        JSON.parse(receiptJson.result.content[0].text).status,
        "not_found",
      );
      assert.doesNotMatch(logs, /synthetic-only|synthetic-test-owner/);
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      await rm(state, { recursive: true, force: true });
    }
  },
);
