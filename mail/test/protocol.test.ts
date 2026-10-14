import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { MAX_MESSAGE } from "../src/schema";
import {
  source,
  readMessage,
  selected,
  submitMessage,
  requireTargetedExpunge,
} from "../src/mail";
const eml = Buffer.from(
  "From: Sender <sender@example.invalid>\r\nTo: owner@example.invalid\r\nSubject: Synthetic mail\r\nMessage-ID: <fixture@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from the fake server.\r\n",
);
async function certificate() {
  await mkdir(".wrangler", { recursive: true });
  const dir = await mkdtemp(path.resolve(".wrangler/mail-cert-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return {
    dir,
    key: readFileSync(path.join(dir, "key.pem")),
    cert: readFileSync(path.join(dir, "cert.pem")),
  };
}
async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  return address.port;
}
test(
  "real ImapFlow TLS protocol: stable UID fetch, MIME read, bounds, targeted deletion",
  { timeout: 30000 },
  async () => {
    const cert = await certificate();
    const commands: string[] = [];
    let size = eml.length;
    const sockets = new Set<net.Socket>();
    const server = tls.createServer(
      { key: cert.key, cert: cert.cert },
      (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.write("* OK fake IMAP ready\r\n");
        let pending = "";
        socket.on("data", (chunk) => {
          pending += chunk.toString();
          let end;
          while ((end = pending.indexOf("\r\n")) !== -1) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 2);
            commands.push(line);
            const tag = line.split(" ")[0];
            const command = line.slice(tag.length + 1);
            const ok = () => socket.write(`${tag} OK done\r\n`);
            if (command === "CAPABILITY") {
              socket.write("* CAPABILITY IMAP4rev1 UIDPLUS\r\n");
              ok();
            } else if (command.startsWith("LOGIN ")) ok();
            else if (
              command.startsWith("LIST ") ||
              command.startsWith("LSUB ")
            ) {
              socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
              ok();
            } else if (/^(SELECT|EXAMINE) /.test(command)) {
              socket.write(
                "* FLAGS (\\Seen \\Draft \\Deleted)\r\n* OK [PERMANENTFLAGS (\\Seen \\Draft \\Deleted \\*)] flags\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 10] valid\r\n* OK [UIDNEXT 43] next\r\n",
              );
              socket.write(`${tag} OK [READ-WRITE] selected\r\n`);
            } else if (command.startsWith("UID FETCH ")) {
              if (/^UID FETCH 42\b/.test(command)) {
                if (/BODY\.PEEK/.test(command)) {
                  socket.write(`* 1 FETCH (UID 42 BODY[] {${eml.length}}\r\n`);
                  socket.write(eml);
                  socket.write(")\r\n");
                } else
                  socket.write(
                    `* 1 FETCH (UID 42 RFC822.SIZE ${size} FLAGS (\\Seen \\Draft))\r\n`,
                  );
              }
              ok();
            } else if (command.startsWith("UID STORE ")) {
              socket.write("* 1 FETCH (UID 42 FLAGS (\\Seen \\Deleted))\r\n");
              ok();
            } else if (command.startsWith("UID EXPUNGE ")) {
              socket.write("* 1 EXPUNGE\r\n");
              ok();
            } else if (command === "LOGOUT") {
              socket.write("* BYE done\r\n");
              ok();
              socket.end();
            } else if (command === "NOOP" || command === "CLOSE") ok();
            else socket.write(`${tag} BAD unsupported synthetic command\r\n`);
          }
        });
      },
    );
    const port = await listen(server);
    const client = new ImapFlow({
      host: "127.0.0.1",
      port,
      secure: true,
      auth: { user: "owner@example.invalid", pass: "synthetic-only" },
      tls: { rejectUnauthorized: false },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableAutoEnable: true,
      connectionTimeout: 5000,
      socketTimeout: 5000,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      const ref = { mailbox: "INBOX", uid: 42, uidValidity: "10" };
      assert.equal((await source(client, ref)).toString(), eml.toString());
      const message = await readMessage(client, ref);
      assert.equal(message.subject, "Synthetic mail");
      assert.match(message.text ?? "", /fake server/);
      assert.ok(
        commands.some((c) => c.includes("BODY.PEEK[]")),
        "read must not mark Seen",
      );
      await assert.rejects(
        source(client, { ...ref, uidValidity: "9" }),
        /UIDVALIDITY/,
      );
      await assert.rejects(
        source(client, { ...ref, uid: 43 }),
        /no longer exists/,
      );
      size = MAX_MESSAGE + 1;
      const previousBodies = commands.filter((c) =>
        /BODY\.PEEK/.test(c),
      ).length;
      await assert.rejects(source(client, ref), /2 MiB read limit/);
      assert.equal(
        commands.filter((c) => /BODY\.PEEK/.test(c)).length,
        previousBodies,
      );
      size = eml.length;
      await selected(client, ref, async () => {
        requireTargetedExpunge(client);
        await client.messageDelete(42, { uid: true });
      });
      assert.ok(commands.some((c) => /UID EXPUNGE 42/.test(c)));
      assert.ok(!commands.some((c) => /^\S+ EXPUNGE/.test(c)));
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cert.dir, { recursive: true, force: true });
    }
  },
);
test(
  "real Nodemailer SMTP: STARTTLS before credentials; DATA accepted, partial recipient rejection truthful",
  { timeout: 30000 },
  async () => {
    const cert = await certificate();
    const secureContext = tls.createSecureContext(cert);
    const commands: string[] = [];
    let data = "";
    let authenticatedUnderTls = false;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 localhost synthetic SMTP\r\n");
      function attach(connection: net.Socket, secure: boolean) {
        let pending = "";
        let collecting = false;
        function onData(chunk: Buffer) {
          pending += chunk.toString();
          if (collecting) {
            const end = pending.indexOf("\r\n.\r\n");
            if (end === -1) return;
            data = pending.slice(0, end);
            pending = pending.slice(end + 5);
            collecting = false;
            connection.write("250 2.0.0 queued synthetic\r\n");
          }
          let end;
          while ((end = pending.indexOf("\r\n")) !== -1) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 2);
            commands.push(line);
            if (line.startsWith("EHLO "))
              connection.write(
                secure
                  ? "250-localhost\r\n250 AUTH PLAIN\r\n"
                  : "250-localhost\r\n250 STARTTLS\r\n",
              );
            else if (line === "STARTTLS") {
              connection.removeListener("data", onData);
              connection.write("220 Ready for TLS\r\n");
              const upgraded = new tls.TLSSocket(connection, {
                isServer: true,
                secureContext,
              });
              sockets.add(upgraded);
              attach(upgraded, true);
              return;
            } else if (line.startsWith("AUTH PLAIN ")) {
              authenticatedUnderTls = secure;
              connection.write(
                secure ? "235 2.7.0 authenticated\r\n" : "530 TLS required\r\n",
              );
            } else if (line.startsWith("MAIL FROM:"))
              connection.write("250 sender ok\r\n");
            else if (line.startsWith("RCPT TO:"))
              connection.write(
                line.includes("reject@")
                  ? "550 recipient rejected\r\n"
                  : "250 recipient ok\r\n",
              );
            else if (line === "DATA") {
              connection.write("354 Send body\r\n");
              collecting = true;
            } else if (line === "QUIT") {
              connection.write("221 goodbye\r\n");
              connection.end();
            } else connection.write("250 ok\r\n");
          }
        }
        connection.on("data", onData);
        connection.on("error", () => {});
      }
      attach(socket, false);
    });
    const port = await listen(server);
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      requireTLS: true,
      auth: { user: "owner@example.invalid", pass: "synthetic-only" },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 5000,
      socketTimeout: 5000,
      logger: false,
      debug: false,
    });
    try {
      const result = await submitMessage(
        {
          ICLOUD_USERNAME: "owner@example.invalid",
          ICLOUD_APP_PASSWORD: "synthetic-only",
          MAIL_IDENTITIES: "owner@example.invalid,alias@example.invalid",
        },
        Buffer.from(
          eml
            .toString()
            .replace(
              "Sender <sender@example.invalid>",
              "alias@example.invalid",
            ),
        ),
        ["friend@example.invalid", "reject@example.invalid"],
        transport,
        "alias@example.invalid",
      );
      assert.equal(authenticatedUnderTls, true);
      assert.ok(
        commands.indexOf("STARTTLS") <
          commands.findIndex((c) => c.startsWith("AUTH ")),
      );
      assert.deepEqual(result.accepted, ["friend@example.invalid"]);
      assert.deepEqual(result.rejected, ["reject@example.invalid"]);
      assert.match(data, /Synthetic mail/);
      assert.ok(
        commands.some((command) =>
          /^MAIL FROM:<alias@example.invalid>/i.test(command),
        ),
      );
      assert.match(data, /^From: alias@example.invalid/m);
    } finally {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cert.dir, { recursive: true, force: true });
    }
  },
);
