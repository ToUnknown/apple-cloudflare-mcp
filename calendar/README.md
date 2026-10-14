# iCloud Calendar MCP

A standalone Cloudflare Worker for one owner's real iCloud CalDAV account. ChatGPT web connects to HTTPS `/mcp` using OAuth 2.1. It has no dependency on the sibling Mail or Contacts Workers.

## Deploy with your agent

Requires Node.js 24+, a Cloudflare account, and an Apple Account with two-factor authentication and an [app-specific password](https://support.apple.com/en-us/102654).

1. Run `npm ci`, then `npm run check`, `npm test`, and `npm run build` in this directory. Tests use synthetic data and local workerd; the build is a Wrangler dry-run.
2. Run `npx wrangler login`. Set a unique `name` and the exact deployed HTTPS origin in `wrangler.jsonc`'s `PUBLIC_ORIGIN` (no trailing slash), for example `https://icloud-calendar-mcp.your-subdomain.workers.dev`. A custom domain is also suitable. `PUBLIC_ORIGIN` must match the origin used by your connector; changing it invalidates existing OAuth audiences.
3. Set secrets interactively, without placing values in command arguments or the repository:

   ```sh
   npx wrangler secret put ICLOUD_USERNAME
   npx wrangler secret put ICLOUD_APP_PASSWORD
   npx wrangler secret put OWNER_PASSWORD
   ```

   `ICLOUD_USERNAME` is your Apple Account email; `ICLOUD_APP_PASSWORD` is its app-specific password. Use a unique random `OWNER_PASSWORD` of at least 32 characters (at most 512). This is the MCP approval password, not your Apple password.
4. Run `npm run deploy`. Current Wrangler provisions the `OAUTH_KV` namespace from the binding without an account-specific ID. Run `npm run types` after configuration changes.
5. In ChatGPT web's custom connector/app configuration, use `https://YOUR-ORIGIN/mcp` with OAuth authentication. The server supports dynamic registration and Client ID Metadata Documents. Sign-in displays the client, its redirect host, and account access; enter `OWNER_PASSWORD` to approve. One approval grants access to read and modify the connected owner's calendars and events.

For local development, copy `.dev.vars.example` to the ignored `.dev.vars`, replace its dummy values if you explicitly want real CalDAV access, and run `npm run dev` at `https://localhost:8787` (accept its local certificate). Local development does not make a localhost URL reachable from ChatGPT web, and the production OAuth flow uses HTTPS secure cookies. The synthetic test suite needs no Apple or Cloudflare account.

## Tools

| Tools | Behavior |
| --- | --- |
| `calendars_list`, `calendars_create`, `calendars_rename` | Discover IDs/privileges/reports; create via extended MKCOL; rename via PROPPATCH with checked property status. iCloud may refuse management methods. |
| `events_search`, `events_read` | Bounded date-range and optional literal, case-insensitive title substring verified locally, including Unicode/folded titles. A master or exception title can match; returns full stored ICS, ETag, series and exceptions. Search returns matching resources, **not expanded occurrences**. |
| `events_create`, `events_update` | Create from complete ICS or patch summary/description/location/times/recurrence rule. Explicit `series` or `occurrence` scope. |
| `events_import`, `events_export` | Replace one complete UID/series with ETag protection, or export exact stored ICS. Import preserves UID; creation chooses a new resource path. |
| `events_move`, `events_delete` | Atomic MOVE between event calendars without overwrite; delete a series or exclude one occurrence. Unsupported destinations are rejected without copy/delete fallback. |
| `availability` | Busy intervals for selected accessible calendars using CalDAV's server expansion. Not other people's availability. Defaults all-day/floating times to Europe/Berlin with DST; explicit timezones remain unchanged. |
| `invitations_reply` | Submit METHOD:REPLY to an advertised scheduling outbox for the authenticated owner's advertised attendee address. Returns per-recipient server status; **does not confirm delivery**. |

Discovery includes supported component types: use `supportsEvents:true` destinations. VTODO-only reminder collections cannot store events. Calendar/event IDs are the discovered absolute CalDAV URLs. ETags must be the exact strong quoted value returned by `events_read`. Writes use `If-Match`; creation uses `If-None-Match: *`. A conflict requires another read. MOVE changes the resource ID while preserving its UID. An error after a mutation may mean the server changed data but verification failed; read before retrying.

For event creation/import provide one VERSION:2.0 VCALENDAR with one UID, one master VEVENT, optional recurrence exceptions, and optional VTIMEZONE definitions. Example:

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Your calendar agent//EN
BEGIN:VEVENT
UID:your-unique-event-id
DTSTAMP:20261014T120000Z
DTSTART:20261015T100000Z
DTEND:20261015T110000Z
SUMMARY:Example meeting
END:VEVENT
END:VCALENDAR
```

All-day times use `DTSTART;VALUE=DATE` and exclusive `DTEND;VALUE=DATE`. Structured patches accept `2026-10-15`, `2026-10-15T10:00:00Z`, or a local datetime plus `timezone`; local TZIDs require a matching VTIMEZONE already in the resource. Use full ICS import to introduce a timezone definition. Occurrence `recurrenceId` identifies the **original** series time, even if the exception was moved. Validation is capped at 10,000 occurrences. Series text edits keep exceptions; changing times or a recurrence rule when exceptions exist is refused to avoid orphaning them. RANGE=THISANDFUTURE edits are refused. Unknown properties survive patches; import intentionally replaces the entire resource.

## Boundaries and verification

- This is single-owner access, not a multi-user Apple login service. Each deployer supplies their own secrets and KV. OAuth codes/tokens and consent handling are provided by Cloudflare's library; S256 PKCE, one-use browser-bound forms, constant-time password comparison, Origin/host checks and no-framing headers protect approval.
- Requests discover `caldav.icloud.com` principal/home/shards rather than guessing account paths. Basic credentials are sent only to HTTPS `caldav.icloud.com` or `p` followed by two or three digits and `-caldav.icloud.com` shard hosts. Redirects are manual, allowlisted and capped. Responses are capped at 2 MiB, requests time out at 15 seconds, ICS writes at 1 MiB, queries at 500 resources and 366 days.
- No calendar sharing, whole-calendar deletion, managed attachment upload/download, Apple-private extension authoring, or inbox processing tools are exposed. Existing unknown properties are preserved rather than interpreted. Apple app-specific passwords do not provide a supported JSON API for those operations.
- Availability defaults all-day/floating events to Europe/Berlin. It still refuses unexpanded recurrence or missing definitions for explicit TZIDs. Use event search/read for those cases.
- Writing organizer/attendee data stores calendar content; it is **not proof of sending an invitation or notification**. A scheduling outbox must be advertised for reply submission. Server acceptance and recipient status are not delivery proof. Automatic server-side scheduling on event PUT depends on iCloud/account permissions and is unverified.
- Local tests cover protocol discovery, unsafe redirects/XML, timeouts/bounds, ETags, recurrence exceptions, embedded timezones/DST, scheduling recipient failures, and OAuth-to-MCP in real workerd. Deployed iCloud workflows are also tested separately; local checks alone do not establish live account connectivity.

References: [CalDAV](https://www.rfc-editor.org/rfc/rfc4791), [iCalendar](https://www.rfc-editor.org/rfc/rfc5545), [CalDAV scheduling](https://www.rfc-editor.org/rfc/rfc6638), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

Availability uses **Europe/Berlin** for DATE/all-day and floating local times. All-day events block local midnight through the exclusive end date (23/25 hours on DST-change days); a DATE without DTEND lasts one local day. Repeated autumn clock times use the first occurrence, and nonexistent spring times shift forward by the DST gap. UTC and explicit event timezones keep their existing meaning. The response includes `defaultTimezone`; stored events are not rewritten.
