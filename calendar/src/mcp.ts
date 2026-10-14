import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CalDAV, CalendarError, boundedText, type Resource } from "./caldav";
import {
  eventDetails,
  uidOf,
  calendarData,
  updateEvent,
  excludeOccurrence,
  busyIntervals,
  expandedTimezones,
  DEFAULT_TIMEZONE,
  validateReply,
} from "./ical";
import type { CalendarEnv } from "./env";
const id = z.string().url().max(2048);
const etag = z.string().min(3).max(200);
const ics = z.string().min(1).max(1_000_000);
const range = {
  start: z.string().describe("UTC ISO YYYY-MM-DDTHH:mm:ssZ, inclusive"),
  end: z
    .string()
    .describe("UTC ISO YYYY-MM-DDTHH:mm:ssZ, exclusive; max 366 days"),
};
const scope = z.enum(["series", "occurrence"]);
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const destructive = { ...write, destructiveHint: true };
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export function calendarServer(env: CalendarEnv): McpServer {
  const server = new McpServer({ name: "icloud-calendar", version: "0.1.0" });
  const dav = new CalDAV(env);
  const safe = <T>(fn: () => Promise<T>) =>
    fn()
      .then(result)
      .catch((error) => ({
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              error instanceof CalendarError
                ? error.message
                : "Invalid or unsupported calendar data; no success was confirmed",
          },
        ],
      }));
  server.registerTool(
    "calendars_list",
    {
      description:
        "Discover accessible calendars, supported components, privileges and reports. Use supportsEvents:true for event operations; VTODO-only collections are not event calendars. IDs are stable CalDAV URLs.",
      inputSchema: {},
      annotations: read,
    },
    () => safe(() => dav.discover()),
  );
  server.registerTool(
    "calendars_create",
    {
      description:
        "Create a VEVENT calendar using extended MKCOL (RFC5689). Server may refuse this capability.",
      inputSchema: {
        name: z.string().min(1).max(300),
        description: z.string().max(2000).optional(),
      },
      annotations: write,
    },
    ({ name, description }) =>
      safe(() => dav.createCalendar(name, description)),
  );
  server.registerTool(
    "calendars_rename",
    {
      description:
        "Rename an accessible calendar with PROPPATCH; checks server property status.",
      inputSchema: { calendarId: id, name: z.string().min(1).max(300) },
      annotations: write,
    },
    ({ calendarId, name }) =>
      safe(async () => {
        await dav.renameCalendar(calendarId, name);
        return { renamed: true };
      }),
  );
  server.registerTool(
    "events_search",
    {
      description:
        "Find event resources intersecting a date range; optional case-insensitive SUMMARY text. Returns full ICS series and exceptions, NOT expanded occurrences.",
      inputSchema: {
        calendarId: id,
        ...range,
        text: z.string().min(1).max(300).optional(),
      },
      annotations: read,
    },
    ({ calendarId, start, end, text }) =>
      safe(async () => ({
        expanded: false,
        resources: (await dav.query(calendarId, start, end, text)).map(
          eventDetails,
        ),
      })),
  );
  server.registerTool(
    "events_read",
    {
      description:
        "Read complete ICS, stable ID, strong ETag, master event and exceptions. Use returned ETag for edits.",
      inputSchema: { eventId: id },
      annotations: read,
    },
    ({ eventId }) => safe(async () => eventDetails(await dav.read(eventId))),
  );
  server.registerTool(
    "events_create",
    {
      description:
        "Create/import one UID including recurrence exceptions as full VCALENDAR ICS. Includes all-day dates and embedded timezone definitions. Stores data; notification delivery is not confirmed.",
      inputSchema: { calendarId: id, ics },
      annotations: write,
    },
    ({ calendarId, ics }) =>
      safe(async () => {
        const uid = uidOf(ics);
        calendarData(ics);
        return eventDetails(await dav.create(calendarId, uid, ics));
      }),
  );
  server.registerTool(
    "events_update",
    {
      description:
        "Patch an event or one recurrence occurrence, preserving unknown fields. Series edits affect master only, existing exceptions remain. DTSTART/DTEND use ISO date or datetime; TZID needs embedded VTIMEZONE.",
      inputSchema: {
        eventId: id,
        etag,
        scope,
        recurrenceId: z.string().max(100).optional(),
        patch: z
          .object({
            summary: z.string().max(1000).optional(),
            description: z.string().max(20000).optional(),
            location: z.string().max(2000).optional(),
            start: z.string().optional(),
            end: z.string().optional(),
            timezone: z.string().max(100).optional(),
            recurrenceRule: z.string().max(1000).nullable().optional(),
          })
          .refine(
            (p) => Object.keys(p).length > 0,
            "At least one patch field is required",
          ),
      },
      annotations: write,
    },
    ({ eventId, etag, scope, recurrenceId, patch }) =>
      safe(async () => {
        const current = await dav.read(eventId);
        if (current.etag !== etag)
          throw new CalendarError("ETag conflict; read the event again");
        return eventDetails(
          await dav.replace(
            eventId,
            etag,
            updateEvent(current.ics, patch, scope, recurrenceId),
          ),
        );
      }),
  );
  server.registerTool(
    "events_import",
    {
      description:
        "Replace a complete series from ICS, including exceptions and unknown extensions. Requires same UID and an ETag. Read/export first; entire resource is replaced.",
      inputSchema: { eventId: id, etag, ics },
      annotations: destructive,
    },
    ({ eventId, etag, ics }) =>
      safe(async () => {
        const current = await dav.read(eventId);
        if (current.etag !== etag)
          throw new CalendarError("ETag conflict; read again");
        if (uidOf(current.ics) !== uidOf(ics))
          throw new CalendarError("Replacement must preserve UID");
        return eventDetails(await dav.replace(eventId, etag, ics));
      }),
  );
  server.registerTool(
    "events_export",
    {
      description:
        "Export exact stored ICS with UID, exceptions, timezone definitions and unknown Apple properties.",
      inputSchema: { eventId: id },
      annotations: read,
    },
    ({ eventId }) => safe(() => dav.read(eventId)),
  );
  server.registerTool(
    "events_move",
    {
      description:
        "Move an entire series to a VEVENT-capable calendar with atomic DAV MOVE, ETag protection and no overwrite. Unsupported destinations are rejected; no delete-first fallback.",
      inputSchema: { eventId: id, calendarId: id, etag },
      annotations: destructive,
    },
    ({ eventId, calendarId, etag }) =>
      safe(async () => eventDetails(await dav.move(eventId, calendarId, etag))),
  );
  server.registerTool(
    "events_delete",
    {
      description:
        "Delete a whole series, or exclude one original recurrence occurrence while preserving other exceptions. Requires current ETag.",
      inputSchema: {
        eventId: id,
        etag,
        scope,
        recurrenceId: z.string().max(100).optional(),
      },
      annotations: destructive,
    },
    ({ eventId, etag, scope, recurrenceId }) =>
      safe(async () => {
        if (scope === "series") {
          if (recurrenceId)
            throw new CalendarError("Series scope cannot include recurrenceId");
          await dav.remove(eventId, etag);
          return { deleted: true, scope };
        }
        if (!recurrenceId)
          throw new CalendarError("Occurrence scope requires recurrenceId");
        const current = await dav.read(eventId);
        if (current.etag !== etag)
          throw new CalendarError("ETag conflict; read again");
        return eventDetails(
          await dav.replace(
            eventId,
            etag,
            excludeOccurrence(current.ics, recurrenceId),
          ),
        );
      }),
  );
  server.registerTool(
    "availability",
    {
      description:
        "Return busy intervals from accessible calendars using server-expanded recurrence. Fails closed if expansion or timezone certainty is unavailable. All-day and floating times default to Europe/Berlin, respecting DST; all-day events block local midnight to exclusive end midnight. Does not report attendees’ availability.",
      inputSchema: { calendarIds: z.array(id).min(1).max(10), ...range },
      annotations: read,
    },
    ({ calendarIds, start, end }) =>
      safe(async () => {
        const resources: Resource[] = [];
        for (const calendar of new Set(calendarIds))
          resources.push(
            ...(await dav.query(calendar, start, end, undefined, true)),
          );
        return {
          calendarIds,
          busy: busyIntervals(
            await expandedTimezones(resources, (id) => dav.read(id)),
            start,
            end,
          ),
          start,
          end,
          scope: "accessible calendars only",
          defaultTimezone: DEFAULT_TIMEZONE,
        };
      }),
  );
  server.registerTool(
    "invitations_reply",
    {
      description:
        "Submit a standards-based METHOD:REPLY ICS to the discovered scheduling outbox. Requires advertised server support. Returns per-recipient scheduling status; delivery is unverified. Editing ATTENDEE alone does not send a response.",
      inputSchema: { ics },
      annotations: write,
    },
    ({ ics }) =>
      safe(async () => {
        const attendee = validateReply(ics);
        const recipients = await dav.schedule(ics, attendee);
        return {
          acceptedByServer: recipients.every((r) => r.status.startsWith("2.")),
          deliveryConfirmed: false,
          recipients,
        };
      }),
  );
  return server;
}
export async function mcpResponse(
  request: Request,
  env: CalendarEnv,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp")
    return new Response("Not found", { status: 404 });
  if (request.method !== "POST")
    return new Response("Use Streamable HTTP POST; this server is stateless", {
      status: 405,
      headers: { Allow: "POST" },
    });
  const body = await boundedText(new Response(request.body), 1_100_000).catch(
    () => null,
  );
  if (body === null) return new Response("Body too large", { status: 413 });
  const server = calendarServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: 1_100_000,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
  } finally {
    await server.close();
  }
}
