import { DurableObject } from "cloudflare:workers";
import {
  buildDraftMessage,
  buildMessage,
  specialFolder,
  submitMessage,
  withImap,
} from "./mail";
import { sendInput, PublicError } from "./schema";
import { selectSender } from "./identities";
import { runSend, type Receipt } from "./receipt";
import type { AppEnv } from "./types";
export class SendReceipt extends DurableObject<AppEnv> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/attempt" && request.method === "POST") {
      // Strongly consistent global approval throttle, independent of eventual-consistency KV.
      return this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const attempts = (
          (await this.ctx.storage.get<number[]>("attempts")) ?? []
        ).filter((t) => t > now - 300000);
        if (attempts.length >= 10)
          return new Response(
            "Approval rate limit exceeded; wait five minutes.",
            { status: 429 },
          );
        attempts.push(now);
        await this.ctx.storage.put("attempts", attempts);
        return new Response("ok");
      });
    }
    if (path === "/receipt" && request.method === "GET") {
      const receipt = await this.ctx.storage.get<Receipt>("receipt");
      if (!receipt) return Response.json({ status: "not_found" });
      const { fingerprint: _fingerprint, ...publicReceipt } = receipt;
      return Response.json(publicReceipt);
    }
    if (path !== "/send" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    let input;
    try {
      input = sendInput.parse(await request.json());
    } catch {
      return Response.json({ error: "Invalid send input." }, { status: 400 });
    }
    if (input.from && input.message)
      return Response.json(
        { error: "Set composed-message sender inside message.from." },
        { status: 400 },
      );
    if (Boolean(input.message) === Boolean(input.draft))
      return Response.json(
        { error: "Supply exactly one message or draft." },
        { status: 400 },
      );
    if (
      input.message &&
      !input.message.to.length &&
      !input.message.cc.length &&
      !input.message.bcc.length
    )
      return Response.json(
        { error: "At least one recipient is required." },
        { status: 400 },
      );
    try {
      selectSender(this.env, input.draft ? input.from : input.message?.from);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof PublicError
              ? error.message
              : "Invalid sender configuration.",
        },
        { status: 400 },
      );
    }
    const fingerprint = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(input)),
      ),
    ).toString("hex");
    const initial: Receipt = {
      operationId: input.operationId,
      messageId: `<${input.operationId}@icloud-mail-mcp.invalid>`,
      fingerprint,
      status: "pending",
      startedAt: new Date().toISOString(),
    };
    const receipt = await runSend(
      {
        reserve: (candidate) =>
          this.ctx.blockConcurrencyWhile(async () => {
            const previous = await this.ctx.storage.get<Receipt>("receipt");
            if (previous) return previous;
            await this.ctx.storage.put("receipt", candidate);
            return null;
          }),
        save: (value) => this.ctx.storage.put("receipt", value),
      },
      initial,
      async () => {
        const { raw, archiveRaw, recipients, from } = input.draft
          ? await buildDraftMessage(
              this.env,
              input.draft,
              initial.messageId,
              input.from,
            )
          : await buildMessage(this.env, input.message!, initial.messageId);
        if (!recipients.length) throw new Error("Draft has no recipients");
        const outcome = await submitMessage(
          this.env,
          raw,
          recipients,
          undefined,
          from,
        );
        try {
          await withImap(this.env, async (c) => {
            const sent = await specialFolder(c, "\\Sent");
            if (!(await c.append(sent, archiveRaw, ["\\Seen"])))
              throw new Error("Append not acknowledged");
          });
          return {
            ...outcome,
            from,
            sentCopy: "saved",
            warning:
              "SMTP server accepted these recipients. Recipient delivery is not confirmed.",
          };
        } catch {
          return {
            ...outcome,
            from,
            sentCopy: "failed",
            warning:
              "SMTP accepted these recipients; Sent copy was not confirmed. Do not resend to repair the copy. Recipient delivery is not confirmed.",
          };
        }
      },
    );
    // Do not retain or return a message body, credentials, or raw SMTP replies in receipts.
    const { fingerprint: _fingerprint, ...publicReceipt } =
      "fingerprint" in receipt ? receipt : { fingerprint: "", ...receipt };
    return Response.json(publicReceipt);
  }
}
