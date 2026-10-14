# Apple Cloudflare MCP

Three independent, Cloudflare-ready MCP servers for Apple iCloud services. Deploy any folder to your own Cloudflare account and connect ChatGPT web or another OAuth-capable MCP client.

| Folder                | Service                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| [mail](mail/)         | iCloud Mail through IMAP/SMTP: messages, drafts, attachments, folders, sending.       |
| [calendar](calendar/) | iCloud Calendar through CalDAV: events, recurrence, availability, invitation replies. |
| [contacts](contacts/) | iCloud Contacts through CardDAV: contacts, lists, membership, vCard import/export.    |

## Setup

Requires Node.js 24+, a Cloudflare account, and an **[Apple app-specific password](https://support.apple.com/en-us/102654)**. Each deployment connects to one owner's iCloud account. Mail tests also require OpenSSL.

1. Clone this repository and enter `mail`, `calendar`, or `contacts`.
2. Set the Worker `name` and its exact HTTPS `PUBLIC_ORIGIN` in that folder's `wrangler.jsonc`.
3. Run:

   ```sh
   npm ci
   npm run check
   npm test
   npm run build
   npx wrangler login
   npm run deploy
   npx wrangler secret put ICLOUD_USERNAME
   npx wrangler secret put ICLOUD_APP_PASSWORD
   npx wrangler secret put OWNER_PASSWORD
   ```

   Use your Apple Account email for Contacts/Calendar; use your primary iCloud Mail address for Mail. `OWNER_PASSWORD` is a separate random password of at least 32 characters for approving MCP access. Enter secrets privately in Wrangler's prompts, never in agent chats or source files. Storage is provisioned automatically.

4. Connect `https://YOUR_WORKER_ORIGIN/mcp` using OAuth and approve with `OWNER_PASSWORD`. Repeat for the other services you want.

To deploy with an agent: **“Deploy the `contacts` folder from this repo to my Cloudflare account. Follow its README and let me enter secrets privately.”** Substitute `mail` or `calendar` as needed.

## Scope

These servers access iCloud protocol features, not every native Apple app feature. Each folder's README lists its tools and limits. Tests use synthetic data; `npm run build` is a deployment dry-run. Live iCloud access, Cloudflare edge connectivity, and ChatGPT web connection require verification on your own deployment.

MIT licensed. Not affiliated with Apple.
