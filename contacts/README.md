# iCloud Contacts MCP on Cloudflare

A standalone, single-owner Worker using real iCloud CardDAV. It exposes standard stateless Streamable HTTP MCP at `/mcp`, protected by OAuth 2.1 with S256 PKCE. Each deployment connects to one Apple account. Apple credentials stay in Worker secrets; clients receive separate MCP OAuth tokens.

## Deploy

Use Node.js 24 or newer and a Cloudflare account. Run these commands from this folder:

```sh
npm ci
npm run check
npm test
npm run build
```

These checks use synthetic records and local workerd/KV only. They do not contact an Apple account, deploy a Worker, or require Cloudflare login.

When you decide to deploy:

1. Set `name` in `wrangler.jsonc` if desired. Set `vars.PUBLIC_ORIGIN` to the exact HTTPS origin your Worker will use, e.g. `https://icloud-contacts-mcp.your-subdomain.workers.dev` (no trailing slash). The placeholder must be replaced.
2. Run `npx wrangler login`, then `npm run deploy`. Wrangler provisions the `OAUTH_KV` namespace automatically; no account-specific IDs belong in this repository. Until secrets are supplied, requests fail closed.
3. Set each secret interactively:

   ```sh
   npx wrangler secret put ICLOUD_USERNAME
   npx wrangler secret put ICLOUD_APP_PASSWORD
   npx wrangler secret put OWNER_PASSWORD
   ```

   `ICLOUD_USERNAME` is your Apple Account email. Generate a dedicated [Apple app-specific password](https://support.apple.com/en-us/102654) for `ICLOUD_APP_PASSWORD`; Apple requires two-factor authentication. `OWNER_PASSWORD` must be a separate random password of at least 32 characters. Never use your Apple Account password as either secret, paste secrets into agent prompts, or commit them.
4. Connect an OAuth-capable remote MCP client to `https://your-worker-origin/mcp`. Dynamic client registration (`/register`) and Client ID Metadata Documents are supported. The authorization page asks for the owner password and explicitly approves access to read, edit and delete contacts/lists. Approve only a client you recognize. ChatGPT web availability depends on your account's custom MCP support; actual ChatGPT/Apple acceptance has not been tested here.

OAuth discovery is available at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`. The owner form uses a one-use browser-bound transaction, same-origin POST, secure cookies, escaped client metadata, a framing prohibition and no-store responses. The Worker rejects cross-origin browser requests, requires the `contacts` scope and owner identity, validates token audiences, and never forwards MCP tokens to Apple. Access tokens expire after an hour; refresh grants expire after 30 days. Revoke a client grant through the provider's revocation endpoint or remove `OAUTH_KV` data to invalidate grants. Removing the Apple app password stops Apple access; rotating only the owner password does not revoke existing MCP grants.

For local development, copy `.dev.vars.example` to `.dev.vars`, replace values privately and use `npm run dev`. It starts a local HTTPS Worker at `https://localhost:8787`; the example sets the matching `PUBLIC_ORIGIN`. Browser approval needs its local certificate trusted/accepted. Local KV is simulated, but providing real Apple secrets allows tools to make real Apple changes. `npm test` always uses its own dummy secrets.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_addressbooks` | Discover collections; returns addressbook IDs. |
| `search_contacts`, `read_contact` | Search all fields; read stable URL IDs, ETags and complete vCards. |
| `save_contact`, `delete_contact` | Create, patch or permanently delete a contact. |
| `list_groups`, `save_group`, `delete_group` | List, create, rename or delete Apple lists/groups. |
| `read_group_members`, `change_group_members` | Resolve group members or add/remove contact UID references. |
| `import_vcards`, `export_vcards` | Import contacts as new records; export original vCards. |

Read before updating or deleting and pass the returned ETag. A concurrent change returns `CONFLICT`; read again and reconsider the change. New records use `If-None-Match: *`. A save can return `etag: null` when Apple omits the response ETag; read the saved ID for its current ETag. Do not automatically retry an uncertain/timed-out write; it may already have succeeded.

`save_contact` accepts a simple `formattedName` plus `properties` (`name`, `value`, optional `parameters`) and `clear` (exact names). Values use vCard syntax: backslash-escape text commas, semicolons, backslashes and newlines; structured properties preserve their separating semicolons. For example:

```json
{
  "formattedName": "Alex Example",
  "properties": [
    { "name": "N", "value": "Example;Alex;;;" },
    { "name": "item1.EMAIL", "parameters": "TYPE=INTERNET", "value": "alex@example.invalid" },
    { "name": "item1.X-ABLabel", "value": "Work" },
    { "name": "item2.TEL", "parameters": "TYPE=CELL", "value": "+49 123 456" },
    { "name": "item2.X-ABLabel", "value": "Mobile" },
    { "name": "ADR", "parameters": "TYPE=HOME", "value": ";;Example Street 1;Berlin;;10115;Germany" },
    { "name": "ORG", "value": "Example Company;Engineering" },
    { "name": "BDAY", "value": "1990-01-01" },
    { "name": "X-PHONETIC-FIRST-NAME", "value": "Aleks" },
    { "name": "NOTE", "value": "Met at an event\\nFollow up later" }
  ]
}
```

Use multiple properties with the same exact name to replace a multi-value field. Unmentioned properties remain intact, including photos, relationships, custom fields and Apple labels. Grouped names are exact: replacing `TEL` does not replace `item2.TEL`. To remove a labeled field, clear both its grouped value and `X-ABLabel` names. `parameters` is the vCard parameter segment after `;` and may not contain a colon or newline. Group membership uses `X-ADDRESSBOOKSERVER-KIND:group` and separate `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:...` properties, rather than editing contact categories. New contacts default their structured `N` given-name component to `formattedName`; set `N` explicitly for family/given/middle/prefix/suffix components.

## Limits and validation status

- Verified locally: TypeScript, Wrangler dry-run, 19 synthetic tests covering genuine workerd OAuth/PKCE and MCP transport, discovery/redirect safety, conditional writes, malformed/incomplete responses, vCard preservation, group membership and import/export. No live Apple, Cloudflare deployment, device sync or ChatGPT acceptance is claimed.
- vCard 3.0/4.0 only; one UID and nonempty FN are required. Photos and custom properties are retained as vCard data. No external photo URLs are fetched. Edits unfold/refold lines without dropping properties; they do not promise byte-identical whitespace. Apple may normalize unsupported fields when storing a record.
- Inventories stop with an explicit error above 5,000 records; remote bodies are bounded to 8 MiB, individual vCards to 1 MiB, and each network request to 20 seconds. Search pages contain at most 50 records. `nextOffset` pages the sorted inventory; restart at zero after adding/deleting records. Search can scan the whole addressbook and match raw vCard fields. Large scans/imports may exceed your Workers plan's execution/subrequest limits; use smaller books/requests or adjust limits after measuring.
- Imports/exports accept up to 100 records. Imports prevalidate the complete input and check existing UIDs, then report every individual write success/failure. They are not atomic. Do not retry successful records. Group import and automatic duplicate merging are deliberately unavailable; export records and explicitly edit/remove duplicates to avoid conflicting fields or broken memberships.
- Lists are group vCards inside an existing addressbook. Creating/deleting whole CardDAV addressbook collections and nested groups are unavailable. Remove memberships before deleting contacts; unresolved UID references are visible in `read_group_members`.
- TLS Basic authentication goes only to `contacts.icloud.com` or `pNNN-contacts.icloud.com` over HTTPS with manual, allowlisted redirects. IPv4/other Apple services/alternate ports/userinfo URLs are rejected. Apple endpoint changes and account-specific behavior require live verification after you choose to connect an account.

Implementation references: [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
