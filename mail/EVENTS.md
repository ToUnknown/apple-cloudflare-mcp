# Incoming-mail events

Mail supports MCP 2.0 (`2026-07-28`) alongside existing clients. When enabled, authenticated `server/discover` advertises `events`; `events/list` exposes `mail.message.received`. `events/subscribe` and `events/unsubscribe` use the [OpenAI MCP Events contract](https://developers.openai.com/plugins/build/mcp-events).

Filters: `mailbox: "INBOX"` (default), optional exact `from` / `to` address, and `subjectContains` (case-insensitive). All filters must match; `to` includes To/Cc headers, not hidden Bcc recipients. Notifications contain header summaries and the stable `ref` accepted by `mail_read`, never message bodies or attachments. No automatic replies or sending are performed.

**Enable only with the account owner's approval for background mailbox reads and header delivery to the callback.** Existing deployments remain unchanged until deployed; the checked-in configuration disables events.

1. Keep existing OAuth/IMAP secrets and `SEND_RECEIPTS` binding. Add the `MAIL_EVENTS` Durable Object binding and `v2-mail-events` migration from `wrangler.jsonc` to any custom deployment config.
2. Generate a random 32-byte base64 encryption key privately and store it using `npx wrangler secret put EVENTS_ENCRYPTION_KEY`. Do not put it in Git or chat. Retain this key while subscriptions exist; changing it makes their stored state unreadable.
3. Optionally restrict `EVENT_CALLBACK_ORIGINS` to comma-separated exact HTTPS origins (no paths/wildcards). Empty permits public HTTPS callbacks after DNS/IP validation and signed challenge verification. Set `MAIL_EVENTS_ENABLED` to `"true"` and deploy Mail. Calendar and Contacts need no changes.
4. Rescan/refresh the Mail plugin in ChatGPT's **Manage** tab. A cached tool list or unchanged plugin version does not establish event support. Verify `server/discover` and `events/list` in a fresh Work chat/dot, then ask to monitor the chosen mail filter.

The server checks the signed callback challenge before activation. Subscriptions, signing keys, checkpoints and pending notifications are AES-GCM encrypted in Durable Object storage. Grant validity is fetched on subscription and cached durably for one hour across all subscriptions. Polling and delivery consult that cache, enforcing known grant expiration immediately. Disconnect can take up to one hour plus provider propagation to stop monitoring; failed refreshes stop delivery until permissions can be checked. Explicit unsubscribe removes the subscription immediately. No Apple password or bearer token is copied into subscription state. Successful callback verification is cached for five minutes by principal, callback URL and signing key; secret rotation verifies again and uses both keys for five minutes.

Detection uses read-only IMAP polling, one shared inbox scan approximately every 30 seconds while subscriptions exist (processing time adds latency; failures back off up to 15 minutes). It starts at current UIDNEXT; existing mail is not replayed. UIDVALIDITY resets establish a fresh baseline. Old copied/moved messages are excluded by their preserved INTERNALDATE; a copy/import that rewrites INTERNALDATE can look like a new arrival. Messages removed before the next poll may be missed. This event does not offer replay (`cursor: null`); expired/unsubscribed gaps are not recovered.

Bounds: five subscriptions, ten UID positions scanned once per tick for all ready subscriptions, three webhook attempts per tick, eight attempts per event with exponential backoff (one minute to one hour). Slow callbacks/backlogs increase latency. Unchanged checkpoints are not rewritten on idle polls. Changed checkpoints and the outbox are saved together before delivery; retries preserve `eventId`. Receivers must deduplicate IDs because a lost acknowledgement can cause redelivery. HTTP 410 removes the subscription; 413 and permanent 4xx are not retried. Failed deliveries are counted in stored subscription state. TTL defaults/caps at 24 hours; refresh before `refreshBefore`. A null requested TTL still receives a finite grant. Unsubscribe removes pending data and secrets; disabling events clears state on the next alarm.

Callbacks use HTTPS, an optional exact origin allowlist, public-address validation on every connection, pinned IP connections, original-host TLS verification, no redirects, and bounded response size/time. Cloudflare TCP restrictions can block some callback destinations (including Cloudflare-hosted IPs). **Do not weaken address validation or fall back to unpinned connections** if verification fails; verify the actual ChatGPT destination during end-to-end testing. Oversized envelopes (over 20 From or To/Cc addresses, 254 characters/address, or 1024 subject characters) fail closed and leave the checkpoint unchanged; this can stall that subscription until the message is moved out or the implementation limit is deliberately raised.

### Verification

`npm test`, `npm run check`, and `npm run build` use synthetic fixtures/local Workers. They do not prove a live ChatGPT subscription. For end-to-end acceptance after owner-approved activation:

- Confirm authenticated discovery/events and existing Mail tools in ChatGPT.
- Subscribe to a unique sender/subject filter; confirm challenge success and a finite expiry. Repeat the same subscription to confirm the same ID. Nonmatching arrivals must not trigger the task.
- Have the user arrange one new matching email; confirm one event-driven task with the correct message ref and no replay of existing mail. Do not send test mail without separate authorization.
- Test transient callback failure/recovery with a controlled receiver: same event ID, fresh signature. Verify unsubscribe, expiration and OAuth revocation stop delivery; reconnect must not replay old mail.
- Remove test subscriptions and fixtures. A successful webhook HTTP acknowledgement alone does not prove ChatGPT ran the intended task.

A continuously active monitor schedules about 2,880 polls/day. Routine grant refresh needs about 24 OAuth KV list operations/day for a single page of grants, plus subscription/OAuth activity and retries. Other Worker and storage usage still counts toward account-wide quotas. No subscriptions means no polling.
