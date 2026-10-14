import { resolve4, resolve6 } from "node:dns/promises";
import { connect } from "node:tls";
import { timingSafeEqual } from "node:crypto";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";

export class EventError extends Error {
  constructor(
    public code: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
  }
}
export function callbackUrl(value: string, origins: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EventError(-32602, "Invalid callback URL");
  }
  const allowed = origins
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    (allowed.length > 0 && !allowed.includes(url.origin)) ||
    ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ""))
  )
    throw new EventError(
      -32015,
      "Callback origin is not allowed",
      "invalid_url",
    );
  return url;
}
export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function signingKey(secret: string): string {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new EventError(-32602, "Invalid signing key");
  const key = Buffer.from(secret.slice(6), "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/, "") !==
      secret.slice(6).replace(/=+$/, "")
  )
    throw new EventError(-32602, "Invalid signing key");
  return secret;
}
export interface WebhookResult {
  status: number;
  body: string;
}
export type WebhookPost = (
  url: URL,
  body: string,
  headers: Record<string, string>,
) => Promise<WebhookResult>;
// https.request in Workers wraps fetch and cannot pin DNS or set servername.
// Connect directly to a validated address with TLS verification for the original host.
export const pinnedPost: WebhookPost = async (url, body, headers) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resolve = Promise.allSettled([
    resolve4(url.hostname),
    resolve6(url.hostname),
  ]);
  const addresses = await Promise.race([
    resolve.then((results) =>
      results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    ),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EventError(-32015, "Callback timeout", "timeout")),
        5000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((a) => !publicAddress(a)))
    throw new EventError(
      -32015,
      "Callback address is not public",
      "invalid_url",
    );
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: addresses[0],
      port: 443,
      servername: url.hostname,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
    });
    const chunks: Buffer[] = [];
    let length = 0;
    const timeout = setTimeout(
      () => socket.destroy(new Error("timeout")),
      10000,
    );
    socket.once("secureConnect", () => {
      const fields = {
        Host: url.host,
        Connection: "close",
        "Content-Length": String(Buffer.byteLength(body)),
        ...headers,
      };
      socket.write(
        `POST ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(fields)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n${body}`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 16384) socket.destroy(new Error("oversized response"));
      else chunks.push(chunk);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new EventError(-32015, "Callback connection failed", "timeout"));
    });
    socket.once("end", () => {
      clearTimeout(timeout);
      try {
        resolve(parseHttpResponse(Buffer.concat(chunks)));
      } catch {
        reject(
          new EventError(
            -32015,
            "Invalid callback response",
            "challenge_failed",
          ),
        );
      }
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      reject(
        new EventError(
          -32015,
          "Callback connection closed",
          "challenge_failed",
        ),
      );
    });
  });
};
export function parseHttpResponse(raw: Buffer): WebhookResult {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("Incomplete headers");
  const head = raw.subarray(0, split).toString();
  const status = Number(/^HTTP\/1\.[01] (\d{3}) /.exec(head)?.[1]);
  if (!status || status < 200) throw new Error("Invalid status");
  let data = raw.subarray(split + 4);
  if (/\r\ntransfer-encoding:\s*chunked\s*(?:\r\n|$)/i.test(head)) {
    const parts: Buffer[] = [];
    for (;;) {
      const end = data.indexOf("\r\n");
      if (
        end < 0 ||
        !/^[0-9a-f]+(?:;.*)?$/i.test(data.subarray(0, end).toString())
      )
        throw new Error("Invalid chunk");
      const size = parseInt(data.subarray(0, end).toString(), 16);
      data = data.subarray(end + 2);
      if (!size) break;
      if (
        data.length < size + 2 ||
        data.subarray(size, size + 2).toString() !== "\r\n"
      )
        throw new Error("Incomplete chunk");
      parts.push(data.subarray(0, size));
      data = data.subarray(size + 2);
    }
    data = Buffer.concat(parts);
  } else {
    const length = /\r\ncontent-length:\s*(\d+)/i.exec(head);
    if (length && data.length !== Number(length[1]))
      throw new Error("Incomplete body");
  }
  return { status, body: data.toString("utf8") };
}
export interface Destination {
  id: string;
  url: string;
  secret: string;
  previousSecret?: string;
  rotationUntil?: number;
}
export async function signedPost(
  dest: Destination,
  eventId: string,
  value: unknown,
  origins: string,
  post = pinnedPost,
  now = Date.now(),
): Promise<WebhookResult> {
  const url = callbackUrl(dest.url, origins);
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 262144)
    throw new EventError(-32602, "Event exceeds payload limit");
  const date = new Date(now);
  const signatures = [
    new Webhook(signingKey(dest.secret)).sign(eventId, date, body),
  ];
  if (dest.previousSecret && (dest.rotationUntil ?? 0) > now)
    signatures.push(
      new Webhook(signingKey(dest.previousSecret)).sign(eventId, date, body),
    );
  return post(url, body, {
    "Content-Type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": String(Math.floor(now / 1000)),
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": dest.id,
  });
}
export async function verifyCallback(
  dest: Destination,
  origins: string,
  post = pinnedPost,
): Promise<void> {
  const challenge = crypto.randomUUID();
  const result = await signedPost(
    dest,
    `verify_${crypto.randomUUID()}`,
    { type: "verification", challenge },
    origins,
    post,
  );
  let echoed: unknown;
  try {
    echoed = JSON.parse(result.body).challenge;
  } catch {
    /* rejected below */
  }
  const expected = Buffer.from(challenge);
  const actual =
    typeof echoed === "string" ? Buffer.from(echoed) : Buffer.alloc(0);
  if (
    result.status < 200 ||
    result.status >= 300 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    throw new EventError(
      -32015,
      "Callback verification failed",
      "challenge_failed",
    );
}
