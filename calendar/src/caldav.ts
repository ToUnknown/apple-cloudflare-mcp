import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { CalendarEnv } from "./env";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
export const xmlEscape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function appleURL(
  value: string,
  base = "https://caldav.icloud.com/",
): URL {
  const url = new URL(value, base);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !/^(?:caldav\.icloud\.com|p\d{2,3}-caldav\.icloud\.com)$/.test(url.hostname)
  )
    throw new CalendarError("Refused non-Apple CalDAV URL");
  if (/%(?:2f|5c|2e)/i.test(url.pathname) || url.pathname.includes("\\"))
    throw new CalendarError("Refused ambiguous CalDAV path");
  return url;
}
export async function boundedText(
  response: Response,
  max = MAX_BYTES,
): Promise<string> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new CalendarError("Response exceeds size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > max) throw new CalendarError("Response exceeds size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
type XmlRecord = Record<string, unknown>;
const list = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const record = (value: unknown): XmlRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlRecord)
    : {};
export const stringValue = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
export interface DavRow {
  href: string;
  props: XmlRecord;
  status: string;
}
export function parseDav(xml: string): DavRow[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new CalendarError("Invalid CalDAV XML");
  const root = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: false,
    htmlEntities: true,
  }).parse(xml) as XmlRecord;
  if (!("multistatus" in root))
    throw new CalendarError("Expected a CalDAV multistatus response");
  const rows = list(record(root.multistatus).response);
  if (rows.length > 500)
    throw new CalendarError("Too many results; narrow the date range");
  return rows.map((value) => {
    const r = record(value);
    if (!stringValue(r.href))
      throw new CalendarError("CalDAV response is missing a resource URL");
    const status = stringValue(r.status);
    if (status && !/\s2\d\d(?:\s|$)/.test(status))
      throw new CalendarError(
        `CalDAV returned an incomplete or failed resource (HTTP ${status.match(/\s(\d{3})/)?.[1] ?? "unknown"})`,
      );
    const props: XmlRecord = {};
    for (const item of list(r.propstat)) {
      const ps = record(item);
      if (/\s200\s/.test(stringValue(ps.status)))
        Object.assign(props, record(ps.prop));
    }
    return { href: stringValue(r.href), props, status: stringValue(r.status) };
  });
}
const propfind = (props: string) =>
  `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;
export interface Calendar {
  id: string;
  name: string;
  description: string;
  etag: string;
  privileges: string[];
  reports: string[];
  components: string[];
  supportsEvents: boolean | null;
}
export interface Discovery {
  calendars: Calendar[];
  home: string;
  outbox?: string;
  userAddresses: string[];
}
export interface Resource {
  id: string;
  etag: string;
  ics: string;
}
export class CalDAV {
  constructor(
    private readonly env: Pick<
      CalendarEnv,
      "ICLOUD_USERNAME" | "ICLOUD_APP_PASSWORD"
    >,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async request(
    href: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; text: string; headers: Headers; url: string }> {
    if (!this.env.ICLOUD_USERNAME || !this.env.ICLOUD_APP_PASSWORD)
      throw new CalendarError("iCloud credentials are not configured");
    // Workers fetch is a global capability; do not bind it to this client.
    const fetchRequest = this.fetcher;
    let url = appleURL(href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetchRequest(url.href, {
          method,
          body,
          headers: {
            Authorization: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${this.env.ICLOUD_USERNAME}:${this.env.ICLOUD_APP_PASSWORD}`)))}`,
            "Content-Type": "application/xml; charset=utf-8",
            ...headers,
          },
          redirect: "manual",
          signal: controller.signal,
        });
        if ([301, 302, 307, 308].includes(response.status)) {
          const target = response.headers.get("location");
          await response.body?.cancel();
          if (!target || redirects === 3)
            throw new CalendarError("Invalid CalDAV redirect");
          url = appleURL(target, url.href);
          continue;
        }
        const text = await boundedText(response);
        if (response.status === 412)
          throw new CalendarError(
            "ETag conflict; read again before changing this resource",
          );
        if (response.status === 401 || response.status === 403)
          throw new CalendarError(
            `CalDAV ${method} denied (HTTP ${response.status}${[
              "no-uid-conflict",
              "valid-calendar-data",
              "calendar-collection-location-ok",
              "need-privileges",
              "supported-calendar-component",
              "valid-calendar-object-resource",
              "allowed-organizer-scheduling-object-change",
            ]
              .filter((condition) =>
                new RegExp(
                  `<(?:(?:[A-Za-z0-9_-]+):)?${condition}(?:\\s|/|>)`,
                ).test(text),
              )
              .map((condition) => `; ${condition}`)
              .join("")}); check permissions or operation support`,
            response.status,
          );
        if (response.status < 200 || response.status >= 300)
          throw new CalendarError(
            `CalDAV ${method} failed (HTTP ${response.status})`,
            response.status,
          );
        return {
          status: response.status,
          text,
          headers: response.headers,
          url: url.href,
        };
      }
      throw new CalendarError("Too many CalDAV redirects");
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw new CalendarError("CalDAV request failed or timed out");
    } finally {
      clearTimeout(timer);
    }
  }
  async discover(): Promise<Discovery> {
    const initial = await this.request(
      "https://caldav.icloud.com/",
      "PROPFIND",
      propfind("<d:current-user-principal/>"),
      { Depth: "0" },
    );
    const principalHref = stringValue(
      record(parseDav(initial.text)[0]?.props["current-user-principal"]).href,
    );
    if (!principalHref)
      throw new CalendarError("CalDAV principal was not discovered");
    const principal = appleURL(principalHref, initial.url).href;
    const info = await this.request(
      principal,
      "PROPFIND",
      propfind(
        "<c:calendar-home-set/><c:schedule-outbox-URL/><c:calendar-user-address-set/>",
      ),
      { Depth: "0" },
    );
    const properties = parseDav(info.text)[0]?.props ?? {};
    const homeHref = stringValue(record(properties["calendar-home-set"]).href);
    if (!homeHref) throw new CalendarError("Calendar home was not discovered");
    const home = appleURL(homeHref, info.url).href;
    const outboxHref = stringValue(
      record(properties["schedule-outbox-URL"]).href,
    );
    const found = await this.request(
      home,
      "PROPFIND",
      propfind(
        "<d:resourcetype/><d:displayname/><d:getetag/><d:current-user-privilege-set/><d:supported-report-set/><c:calendar-description/><c:supported-calendar-component-set/>",
      ),
      { Depth: "1" },
    );
    const calendars = parseDav(found.text)
      .filter((row) => "calendar" in record(row.props.resourcetype))
      .map((row) => ({
        id: appleURL(row.href, found.url).href,
        name: stringValue(row.props.displayname),
        description: stringValue(row.props["calendar-description"]),
        etag: stringValue(row.props.getetag),
        components: list(
          record(row.props["supported-calendar-component-set"]).comp,
        )
          .map((c) => stringValue(record(c)["@_name"]))
          .filter(Boolean),
        supportsEvents:
          row.props["supported-calendar-component-set"] === undefined
            ? null
            : list(
                record(row.props["supported-calendar-component-set"]).comp,
              ).some((c) => stringValue(record(c)["@_name"]) === "VEVENT"),
        privileges: list(
          record(row.props["current-user-privilege-set"]).privilege,
        ).flatMap((v) => Object.keys(record(v))),
        reports: list(
          record(row.props["supported-report-set"])["supported-report"],
        ).flatMap((v) => Object.keys(record(record(v).report))),
      }));
    return {
      calendars,
      home,
      outbox: outboxHref ? appleURL(outboxHref, info.url).href : undefined,
      userAddresses: list(record(properties["calendar-user-address-set"]).href)
        .map(stringValue)
        .filter(Boolean),
    };
  }
  async calendar(id: string): Promise<Calendar> {
    const calendar = (await this.discover()).calendars.find((c) => c.id === id);
    if (!calendar)
      throw new CalendarError(
        "Calendar is not accessible; use calendars_list first",
      );
    if (calendar.supportsEvents === false)
      throw new CalendarError(
        "This collection does not support VEVENT events; choose an event calendar from calendars_list",
      );
    return calendar;
  }
  async eventURL(id: string): Promise<string> {
    const url = appleURL(id);
    const { calendars } = await this.discover();
    if (
      !calendars.some((c) => {
        if (c.supportsEvents === false) return false;
        const parent = new URL(c.id);
        const prefix = parent.pathname.endsWith("/")
          ? parent.pathname
          : `${parent.pathname}/`;
        return (
          url.origin === parent.origin &&
          url.pathname.startsWith(prefix) &&
          !url.pathname.slice(prefix.length).includes("/") &&
          url.pathname.slice(prefix.length).endsWith(".ics")
        );
      })
    )
      throw new CalendarError("Event is outside an accessible calendar");
    return url.href;
  }
  async read(id: string): Promise<Resource> {
    const href = await this.eventURL(id);
    // REPORT returns the entity and its strong ETag atomically. iCloud GET may use a weak ETag.
    const parent = new URL(".", href).href;
    const result = await this.request(
      parent,
      "REPORT",
      `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>${xmlEscape(new URL(href).pathname)}</d:href></c:calendar-multiget>`,
      { Depth: "1" },
    );
    const rows = parseDav(result.text);
    if (rows.length !== 1 || appleURL(rows[0].href, result.url).href !== href)
      throw new CalendarError("Calendar read returned an unexpected resource");
    const etag = stringValue(rows[0].props.getetag);
    strongEtag(etag);
    const ics = stringValue(rows[0].props["calendar-data"]);
    if (!ics) throw new CalendarError("Calendar read omitted event data");
    return { id: href, etag, ics };
  }

  async readMany(
    calendarId: string,
    expected: Resource[],
  ): Promise<Resource[]> {
    if (!expected.length) return [];
    await this.calendar(calendarId);
    const parent = appleURL(calendarId);
    const prefix = parent.pathname.endsWith("/")
      ? parent.pathname
      : `${parent.pathname}/`;
    const wanted = new Map(expected.map((r) => [r.id, r.etag]));
    if (wanted.size !== expected.length || wanted.size > 500)
      throw new CalendarError("Invalid or oversized resource list");
    for (const id of wanted.keys()) {
      const u = appleURL(id);
      if (
        u.origin !== parent.origin ||
        !u.pathname.startsWith(prefix) ||
        u.pathname.slice(prefix.length).includes("/")
      )
        throw new CalendarError("Event is outside the requested calendar");
    }
    const result: Resource[] = [];
    let bytes = 0;
    for (let offset = 0; offset < expected.length; offset += 50) {
      const batch = expected.slice(offset, offset + 50);
      const pending = new Set(batch.map((r) => r.id));
      const response = await this.request(
        calendarId,
        "REPORT",
        `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>${batch.map((r) => `<d:href>${xmlEscape(new URL(r.id).pathname)}</d:href>`).join("")}</c:calendar-multiget>`,
        { Depth: "1" },
      );
      for (const row of parseDav(response.text)) {
        const id = appleURL(row.href, response.url).href;
        const etag = stringValue(row.props.getetag),
          ics = stringValue(row.props["calendar-data"]);
        if (!pending.delete(id) || !ics)
          throw new CalendarError(
            "Incomplete or unexpected search metadata; retry search",
          );
        if (etag !== wanted.get(id))
          throw new CalendarError("ETag conflict during search; retry search");
        strongEtag(etag);
        bytes += new TextEncoder().encode(ics).length;
        if (bytes > 2 * 1024 * 1024)
          throw new CalendarError(
            "Search metadata exceeds size limit; narrow the date range",
          );
        result.push({ id, etag, ics });
      }
      if (pending.size)
        throw new CalendarError("Incomplete search metadata; retry search");
    }
    return result;
  }

  // iCloud's time-range selection can omit a series whose exception was moved
  // beyond the original recurrence span. Read a bounded complete inventory so
  // detached exceptions are never dependent on that selection.
  async searchOriginals(calendarId: string): Promise<Resource[]> {
    await this.calendar(calendarId);
    const response = await this.request(
      calendarId,
      "REPORT",
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`,
      { Depth: "1" },
    );
    const parent = appleURL(calendarId);
    const prefix = parent.pathname.endsWith("/")
      ? parent.pathname
      : `${parent.pathname}/`;
    const seen = new Set<string>();
    return parseDav(response.text).flatMap((row) => {
      const url = appleURL(row.href, response.url);
      // iCloud includes the collection itself with an ETag but no event data.
      if (
        url.origin === parent.origin &&
        (url.pathname === parent.pathname || url.pathname === prefix)
      )
        return [];
      if (
        url.origin !== parent.origin ||
        !url.pathname.startsWith(prefix) ||
        url.pathname.slice(prefix.length).includes("/") ||
        seen.has(url.href)
      )
        throw new CalendarError(
          "Unexpected or duplicate calendar search resource",
        );
      seen.add(url.href);
      const etag = stringValue(row.props.getetag),
        ics = stringValue(row.props["calendar-data"]);
      strongEtag(etag);
      if (!ics) throw new CalendarError("Incomplete calendar search inventory");
      return [{ id: url.href, etag, ics }];
    });
  }

  async query(
    calendarId: string,
    start: string,
    end: string,
    text?: string,
    expand = false,
  ): Promise<Resource[]> {
    await this.calendar(calendarId);
    let startDate = rangeStamp(start),
      endDate = rangeStamp(end);
    if (
      Date.parse(start) >= Date.parse(end) ||
      Date.parse(end) - Date.parse(start) > 366 * 86400000
    )
      throw new CalendarError("Range must be increasing and at most 366 days");
    // Floating/DATE events may be filtered using the server's timezone. Widen
    // discovery so Berlin-local boundary events are retained, then clip locally.
    if (expand) {
      startDate = rangeStamp(
        new Date(Date.parse(start) - 86400000)
          .toISOString()
          .replace(".000Z", "Z"),
      );
      endDate = rangeStamp(
        new Date(Date.parse(end) + 86400000)
          .toISOString()
          .replace(".000Z", "Z"),
      );
    }
    const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data>${expand ? `<c:expand start="${startDate}" end="${endDate}"/>` : ""}</c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${startDate}" end="${endDate}"/>${text ? `<c:prop-filter name="SUMMARY"><c:text-match collation="i;unicode-casemap">${xmlEscape(text)}</c:text-match></c:prop-filter>` : ""}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const response = await this.request(calendarId, "REPORT", body, {
      Depth: "1",
    });
    return parseDav(response.text).map((row) => {
      if (
        !stringValue(row.props["calendar-data"]) ||
        !stringValue(row.props.getetag)
      )
        throw new CalendarError(
          "Incomplete event query; availability and search results cannot be trusted",
        );
      return {
        id: appleURL(row.href, response.url).href,
        etag: stringValue(row.props.getetag),
        ics: stringValue(row.props["calendar-data"]),
      };
    });
  }
  async create(
    calendarId: string,
    uid: string,
    ics: string,
  ): Promise<Resource> {
    await this.calendar(calendarId);
    const url = new URL(
      `${crypto.randomUUID()}.ics`,
      calendarId.endsWith("/") ? calendarId : `${calendarId}/`,
    ).href;
    await this.request(url, "PUT", ics, {
      "Content-Type": "text/calendar; charset=utf-8",
      "If-None-Match": "*",
    });
    try {
      return await this.read(url);
    } catch {
      throw new CalendarError(
        `Event was created at ${url}, but verification failed. Do not create again; read this event ID.`,
      );
    }
  }
  async replace(id: string, etag: string, ics: string): Promise<Resource> {
    strongEtag(etag);
    const href = await this.eventURL(id);
    await this.request(href, "PUT", ics, {
      "Content-Type": "text/calendar; charset=utf-8",
      "If-Match": etag,
    });
    try {
      return await this.read(href);
    } catch {
      throw new CalendarError(
        `Event was updated at ${href}, but verification failed. Read it again before another edit.`,
      );
    }
  }
  async remove(id: string, etag: string): Promise<void> {
    strongEtag(etag);
    await this.request(await this.eventURL(id), "DELETE", undefined, {
      "If-Match": etag,
    });
  }
  async move(id: string, calendarId: string, etag: string): Promise<Resource> {
    strongEtag(etag);
    const source = await this.eventURL(id);
    await this.calendar(calendarId);
    const destination = new URL(
      source.split("/").at(-1)!,
      calendarId.endsWith("/") ? calendarId : `${calendarId}/`,
    ).href;
    if (source === destination)
      throw new CalendarError("Source and destination calendar are the same");
    if (new URL(source).origin !== new URL(destination).origin)
      throw new CalendarError(
        "Moving between different CalDAV origins is unsupported",
      );
    await this.request(source, "MOVE", undefined, {
      Destination: destination,
      Overwrite: "F",
      "If-Match": etag,
    });
    try {
      return await this.read(destination);
    } catch {
      throw new CalendarError(
        `Move completed to ${destination}, but verification failed. Read that ID before retrying.`,
      );
    }
  }
  async createCalendar(name: string, description = ""): Promise<Calendar> {
    const { home } = await this.discover();
    const href = new URL(
      `${crypto.randomUUID()}/`,
      home.endsWith("/") ? home : `${home}/`,
    ).href;
    // RFC5689 extended MKCOL is equivalent; Workers fetch rejects MKCALENDAR.
    await this.request(
      href,
      "MKCOL",
      `<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${xmlEscape(name)}</d:displayname><c:calendar-description>${xmlEscape(description)}</c:calendar-description><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>`,
      { "If-None-Match": "*" },
    );
    const created = (await this.discover()).calendars.find(
      (c) => c.id === href,
    );
    if (!created || created.name !== name)
      throw new CalendarError(
        "Calendar creation could not be verified; inspect calendars before retrying",
      );
    return created;
  }
  async renameCalendar(id: string, name: string): Promise<void> {
    await this.calendar(id);
    const result = await this.request(
      id,
      "PROPPATCH",
      `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>${xmlEscape(name)}</d:displayname></d:prop></d:set></d:propertyupdate>`,
    );
    if (
      result.status === 207 &&
      !parseDav(result.text).some((r) => r.props.displayname !== undefined)
    )
      throw new CalendarError("Calendar rename was not accepted");
  }
  async schedule(
    ics: string,
    attendee: string,
  ): Promise<{ recipient: string; status: string }[]> {
    const { outbox, userAddresses } = await this.discover();
    if (!outbox)
      throw new CalendarError(
        "Server does not advertise a scheduling outbox; delivery is unsupported",
      );
    if (
      !userAddresses.some(
        (address) => address.toLowerCase() === attendee.toLowerCase(),
      )
    )
      throw new CalendarError(
        "Reply attendee must match an advertised address of the authenticated owner",
      );
    const response = await this.request(outbox, "POST", ics, {
      "Content-Type": "text/calendar; charset=utf-8",
    });
    if (
      /<!DOCTYPE|<!ENTITY/i.test(response.text) ||
      XMLValidator.validate(response.text) !== true
    )
      throw new CalendarError(
        "Scheduling returned invalid XML; result is uncertain",
      );
    const root = new XMLParser({
      removeNSPrefix: true,
      parseTagValue: false,
    }).parse(response.text) as XmlRecord;
    const rows = list(record(root["schedule-response"]).response).map(
      (value) => {
        const row = record(value);
        return {
          recipient: stringValue(record(row.recipient).href),
          status: stringValue(row["request-status"]),
        };
      },
    );
    if (!rows.length || rows.some((row) => !row.recipient || !row.status))
      throw new CalendarError(
        "No recipient scheduling status was returned; result is uncertain",
      );
    return rows;
  }
}
export function strongEtag(etag: string): void {
  if (!/^"[^\r\n"]+"$/.test(etag))
    throw new CalendarError("Supply the strong ETag from events_read");
}
export function rangeStamp(value: string): string {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new CalendarError(
      "Range boundaries must be UTC ISO timestamps (YYYY-MM-DDTHH:mm:ssZ)",
    );
  if (new Date(value).toISOString().replace(".000Z", "Z") !== value)
    throw new CalendarError("Invalid calendar date");
  return value.replace(/[-:]/g, "");
}
