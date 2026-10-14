# iCloud Mail MCP

Standalone Cloudflare Worker for one owner's iCloud Mail. Standard Streamable HTTP MCP at `/mcp`, protected by OAuth 2.1 (S256 PKCE, dynamic client registration/CIMD, owner-password consent). It uses ImapFlow, Nodemailer and PostalMime against Apple's documented `imap.mail.me.com:993` TLS and `smtp.mail.me.com:587` STARTTLS services. No computer relay is required.

## Deploy

Requires Node.js 22+, npm, a Cloudflare account with Workers/KV/Durable Objects, enabled iCloud Mail and an [Apple app-specific password](https://support.apple.com/en-us/102654). Use your full primary iCloud Mail address for `ICLOUD_USERNAME`, rather than an unrelated Apple Account login. [Apple's server settings](https://support.apple.com/en-us/102525).

```sh
npm ci
npx wrangler login
```

Set `PUBLIC_ORIGIN` in `wrangler.jsonc` to your exact HTTPS Worker origin (no trailing slash), e.g. `https://icloud-mail-mcp.YOUR_SUBDOMAIN.workers.dev`. A custom domain also works when its Worker route is configured. Keep that origin consistent with the endpoint you give clients.

```sh
npx wrangler secret put ICLOUD_USERNAME
npx wrangler secret put ICLOUD_APP_PASSWORD
npx wrangler secret put OWNER_PASSWORD
npm run check
npm test
npm run build
npm run deploy
```

Set `OWNER_PASSWORD` to at least 32 randomly generated characters and keep it separate from Apple's password. Secrets are entered interactively; never paste them into source, terminal arguments or an agent transcript. Wrangler provisions the `OAUTH_KV` namespace and `SEND_RECEIPTS` Durable Object automatically. Optional sender identities use `MAIL_IDENTITIES` (comma-separated plain addresses) and `MAIL_FROM` (preferred sender), both set once with `wrangler secret put`. For example, set `MAIL_IDENTITIES` to `owner@icloud.com,alias@icloud.com,me@example.com` and `MAIL_FROM` to `me@example.com`. With an explicit allowlist, the preferred sender (or default `ICLOUD_USERNAME`) must appear in it. Without an allowlist, the primary address and optional legacy `MAIL_FROM` are allowed. Each alias/custom-domain address must already be authorized on this same iCloud account; the server does not create/discover aliases or verify their authorization with Apple.

In ChatGPT web, add a custom MCP connector/app pointing to `https://YOUR_ORIGIN/mcp`. Its OAuth flow shows the requesting client and redirect, then asks for the deployment owner's password and approval. Each deployment serves only the configured owner's mailbox. Grant `mail` (and optionally `offline_access`); access includes all listed tools. Apple credentials stay in Worker secrets and are not supplied to MCP clients. Changing OWNER_PASSWORD protects future approvals; existing OAuth tokens require separate revocation or namespace reset to disconnect clients.

An agent deploying this folder should install dependencies, ask the owner to enter the three secrets privately, set the canonical origin, run the checks, and deploy only with explicit deployment authorization. It should perform a harmless `mail_folders` check before proposing live mutations.

## Tools

| Tool                                 | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `mail_identities`                    | Allowed sender addresses and preferred default                             |
| `mail_folders`, `mail_folder_status` | Folders, special-use roles, counts, UIDVALIDITY, advertised quota          |
| `mail_folder_manage`                 | Create/rename/delete folders and subscribe/unsubscribe                     |
| `mail_search`                        | Compact subject/from/date/flags and stable refs; bounded newest-first pagination. `detail: "full"` includes envelope metadata. |
| `mail_read`, `mail_attachment`       | MIME bodies and attachment metadata/download                               |
| `mail_export_eml`, `mail_import_eml` | Original EML export/append (import never sends)                            |
| `mail_draft_save`                    | Create or replace a Draft; saves Bcc and appends before removing old draft |
| `mail_send`, `mail_send_draft`       | SMTP send, replies and attachments; draft send retains original draft      |
| `mail_send_receipt`                  | Retrieve a durable operation receipt without resending                     |
| `mail_mark`                          | Add/remove standard flags or bounded custom keywords                       |
| `mail_move`                          | Move/copy to a folder, Archive, Trash or Junk                              |
| `mail_delete`                        | Confirmed permanent deletion of exactly one UID                            |

Use `mail_identities` to see sender choices, then optionally set `message.from` on `mail_send` or `mail_draft_save`. New messages use the preferred identity. Replies with `replyToMessage` default to the first allowed receiving address in the original To, then Cc; if neither matches, they use the preferred identity. Incoming From/Reply-To never choose the sending identity. An explicit allowed `from` takes precedence. `mail_send_draft` preserves the draft's allowed From address; its optional top-level `from` overrides it. A draft with an unconfigured From is refused until an allowed override is chosen. The SMTP envelope sender matches the selected From. There is no per-tool account argument.

Search output is compact by default; full message bodies remain in `mail_read`. Search has an explicit output schema. Tool results include structured content, and failures return `error: {code, message, retryable, nextAction}`. Reusing a send operationId with different content returns `OPERATION_CONFLICT` with `isError: true`.

Message refs require `{mailbox, uid, uidValidity}` returned by search. Stale refs fail closed. Permanent message deletion requires UIDPLUS/IMAP4rev2 targeted UID EXPUNGE; broad EXPUNGE is refused. Special folders use server-advertised roles and fail clearly if missing. Folder deletion requires explicit `confirm=true`.

`mail_send`/`mail_send_draft` require a UUID `operationId` for each intended send. Reusing it returns its receipt; changing its content with the same UUID is rejected. The Durable Object records `pending` **before** SMTP. If a process/connection fails after submission begins, the result remains pending/uncertain and that ID never retries automatically. Inspect Sent and recipient state before deciding whether a new send is justified. Receipts distinguish SMTP acceptance, rejected recipients and Sent-copy success; SMTP acceptance does not establish recipient delivery. Do not delete receipt storage if you depend on replay protection. Receipts retain identifiers, timestamps and recipient addresses, but no bodies or Apple secrets.

## Limits and verification

- 2 MiB original/encoded EML; 1 MiB per downloaded attachment and combined composed attachments; 50 total recipients. Larger messages fail with instructions to use a mail client.
- Search examines at most 10,000 UIDs per window and returns at most 50 messages. Continue with `nextBeforeUid`, including across an empty window. Folder listing returns at most 200 folders. Read bodies are capped at 100,000 characters each and report truncation.
- Sending a stored draft rebuilds standard MIME fields, attachments and reply headers; custom headers, signatures/encrypted MIME and original formatting are not preserved. Use original EML export for archival fidelity. A draft remains after send.
- SMTP acceptance and Sent filing are separate operations. iCloud may itself file a Sent copy; server behavior must be checked on the live account. Sent-copy failure never causes a resend. Draft replace/import/other IMAP writes can also have uncertain outcomes; inspect mailbox state before repeating them.
- IMAP/SMTP do not expose iCloud web rules, Hide My Email management, scheduled send, undo send, VIP settings or Apple-specific web features. This server implements real protocol operations, without pretending those features exist.
- Tests use synthetic account details only: actual workerd OAuth/PKCE/CSRF/MCP transport and Durable Object receipt lookup; real local TLS IMAP and SMTP STARTTLS conversations with the maintained libraries; MIME, bounds, UID targeting and receipt-state tests. TypeScript and Wrangler dry-run verify the production bundle. Local workerd cannot bypass self-signed TLS/private-socket restrictions for a complete synthetic TLS exchange; protocol exchanges run under Node. Live deployed iCloud reading, writing, search, and SMTP acceptance have also been checked. SMTP acceptance and a saved Sent copy do not prove recipient delivery.

For local development copy `.dev.vars.example` to ignored `.dev.vars`, set dummy values, and override `PUBLIC_ORIGIN` to `http://127.0.0.1:8787` in that file before `npm run dev`. Dummy credentials cannot access mail. Real credentials would access the configured mailbox when a mail tool runs. `npm test` needs OpenSSL for ephemeral synthetic TLS certificates and uses local ports only.

Current [Cloudflare node:tls support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/) and compatibility date `2026-10-14` are required. OAuth protected-resource metadata is at `/.well-known/oauth-protected-resource/mcp`. No unauthenticated HTTP route sends or changes mail; Durable Object handlers are reachable only through the Worker binding.
