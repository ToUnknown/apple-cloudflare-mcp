import { describe, test, expect, vi } from "vitest";
import {
  CalDAV,
  CalendarError,
  appleURL,
  boundedText,
  parseDav,
} from "../src/caldav";
import {
  calendarData,
  eventDetails,
  updateEvent,
  excludeOccurrence,
  busyIntervals,
  expandedTimezones,
  validateReply,
} from "../src/ical";
const origin = "https://p01-caldav.icloud.com";
const calendar = `${origin}/u/cal/`;
const env = {
  ICLOUD_USERNAME: "synthetic@example.invalid",
  ICLOUD_APP_PASSWORD: "dummy-app-password",
};
const xml = (props: string, href = "/u/cal/") =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const sample =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//synthetic//EN\r\nBEGIN:VEVENT\r\nUID:event-one\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261014T100000Z\r\nDTEND:20261014T110000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Test\r\nX-APPLE-CUSTOM:keep-me\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
function fixture(
  extra?: (url: string, init: RequestInit) => Response | undefined,
) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url === "https://caldav.icloud.com/")
      return new Response(null, {
        status: 307,
        headers: { Location: `${origin}/` },
      });
    if (url === `${origin}/`)
      return new Response(
        xml(
          "<d:current-user-principal><d:href>/u/principal/</d:href></d:current-user-principal>",
          "/",
        ),
        { status: 207 },
      );
    if (url === `${origin}/u/principal/`)
      return new Response(
        xml(
          "<c:calendar-home-set><d:href>/u/</d:href></c:calendar-home-set>",
          "/u/principal/",
        ),
        { status: 207 },
      );
    if (url === `${origin}/u/`)
      return new Response(
        xml(
          '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal</d:displayname><d:getetag>"calendar-tag"</d:getetag><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>',
        ),
        { status: 207 },
      );
    if (init.method === "GET" && url.endsWith(".ics"))
      return new Response(sample, { headers: { ETag: '"v1"' } });
    if (
      init.method === "REPORT" &&
      String(init.body).includes("calendar-multiget")
    ) {
      const href = String(init.body).match(/<d:href>(.*?)<\/d:href>/)![1];
      return new Response(
        xml(
          `<d:getetag>"v1"</d:getetag><c:calendar-data>${escape(sample).replace(/\r/g, "&#13;")}</c:calendar-data>`,
          href,
        ),
        { status: 207 },
      );
    }
    if (init.method === "REPORT")
      return new Response(
        xml(
          `<d:getetag>"v1"</d:getetag><c:calendar-data>${escape(sample)}</c:calendar-data>`,
          "/u/cal/event-one.ics",
        ),
        { status: 207 },
      );
    if (["PUT", "MOVE", "DELETE", "MKCOL"].includes(init.method ?? ""))
      return new Response(null, { status: 204 });
    throw new Error(`Unexpected synthetic request ${init.method} ${url}`);
  });
}
describe("CalDAV boundaries and real protocol operations", () => {
  test("incomplete reports cannot be mistaken for an empty calendar", async () => {
    for (const body of [
      "<html>upstream error</html>",
      xml('<d:getetag>"v1"</d:getetag>', "/u/cal/event-one.ics"),
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/u/cal/event-one.ics</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response></d:multistatus>',
    ]) {
      const dav = new CalDAV(
        env,
        fixture((_, init) =>
          init.method === "REPORT"
            ? new Response(body, { status: 207 })
            : undefined,
        ) as typeof fetch,
      );
      await expect(
        dav.query(
          calendar,
          "2026-10-14T00:00:00Z",
          "2026-10-15T00:00:00Z",
          undefined,
          true,
        ),
      ).rejects.toThrow();
    }
    const empty = new CalDAV(
      env,
      fixture((_, init) =>
        init.method === "REPORT"
          ? new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 })
          : undefined,
      ) as typeof fetch,
    );
    await expect(
      empty.query(calendar, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"),
    ).resolves.toEqual([]);
  });
  test("discovers shard, principal, home, accessible calendars and privileges", async () => {
    const mock = fixture();
    const found = await new CalDAV(env, mock as typeof fetch).discover();
    expect(found.calendars[0]).toMatchObject({
      id: calendar,
      name: "Personal",
      privileges: ["write"],
    });
    expect(mock.mock.calls[1][1]).toMatchObject({ redirect: "manual" });
  });
  test("redirect credentials never reach an attacker", async () => {
    const mock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://p01-caldav.icloud.com.attacker.test/" },
        }),
    );
    await expect(
      new CalDAV(env, mock as typeof fetch).discover(),
    ).rejects.toThrow("Refused non-Apple");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  test("rejects scheme, userinfo, ports, ambiguous paths and XML entities", () => {
    for (const value of [
      "http://caldav.icloud.com/",
      "https://user@caldav.icloud.com/",
      "https://caldav.icloud.com:8443/",
      `${calendar}a%2Fb.ics`,
    ])
      expect(() => appleURL(value)).toThrow();
    expect(() =>
      parseDav('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x/>'),
    ).toThrow();
  });
  test("request timeout aborts and hides provider details", async () => {
    vi.useFakeTimers();
    const mock = vi.fn(
      (_: unknown, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("secret text")),
          ),
        ),
    );
    const pending = expect(
      new CalDAV(env, mock as typeof fetch).discover(),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15001);
    await pending;
    vi.useRealTimers();
  });
  test("size limits stop streaming and partial prop failures do not become success", async () => {
    await expect(boundedText(new Response("abcdef"), 3)).rejects.toThrow(
      "size limit",
    );
    expect(
      parseDav(
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop><d:displayname>bad</d:displayname></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>',
      )[0].props,
    ).toEqual({});
  });
  test("series query requests time-range without pretending expansion", async () => {
    const mock = fixture();
    const dav = new CalDAV(env, mock as typeof fetch);
    const events = await dav.query(
      calendar,
      "2026-10-14T00:00:00Z",
      "2026-10-20T00:00:00Z",
      "Test & more",
    );
    expect(events[0].ics.replace(/\r\n/g, "\n")).toEqual(
      sample.replace(/\r\n/g, "\n"),
    );
    const report = mock.mock.calls.find((c) => c[1]?.method === "REPORT")![1];
    expect(report?.body).toContain("Test &amp; more");
    expect(report?.body).not.toContain("<c:expand");
    expect(eventDetails(events[0])).toMatchObject({ expanded: false });
  });
  test("conditional edits, creation and atomic MOVE carry concurrency headers", async () => {
    const mock = fixture();
    const dav = new CalDAV(env, mock as typeof fetch);
    await dav.replace(`${calendar}event-one.ics`, '"v1"', sample);
    await dav.create(calendar, "event-one", sample);
    const writes = mock.mock.calls
      .filter((c) => c[1]?.method === "PUT")
      .map((c) => c[1]?.headers as Record<string, string>);
    expect(writes[0]["If-Match"]).toEqual('"v1"');
    expect(writes[1]["If-None-Match"]).toEqual("*");
    await expect(
      dav.move(`${calendar}event-one.ics`, calendar, '"v1"'),
    ).rejects.toThrow("same");
  });
  test("ETag conflicts and missing scheduling capability fail clearly", async () => {
    const mock = fixture((_, init) =>
      init.method === "PUT" ? new Response(null, { status: 412 }) : undefined,
    );
    const dav = new CalDAV(env, mock as typeof fetch);
    await expect(
      dav.replace(`${calendar}event-one.ics`, '"old"', sample),
    ).rejects.toThrow("ETag conflict");
    await expect(
      dav.replace(`${calendar}event-one.ics`, "*", sample),
    ).rejects.toThrow("strong ETag");
    await expect(
      dav.schedule(sample, "mailto:synthetic@example.invalid"),
    ).rejects.toThrow("not advertise");
  });
  test("rejects resources outside accessible calendars and overly large date ranges", async () => {
    const dav = new CalDAV(env, fixture() as typeof fetch);
    await expect(dav.read(`${origin}/other/event.ics`)).rejects.toThrow(
      "outside",
    );
    await expect(
      dav.query(calendar, "2026-10-14T00:00:00Z", "2028-10-14T00:00:00Z"),
    ).rejects.toThrow("366");
  });
});
describe("iCalendar fidelity and recurrence semantics", () => {
  test("malformed expanded resources never imply free time", () => {
    for (const ics of [
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR",
      "BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD",
    ]) {
      expect(() =>
        busyIntervals(
          [{ id: "invalid", etag: '"v1"', ics }],
          "2026-10-14T00:00:00Z",
          "2026-10-15T00:00:00Z",
        ),
      ).toThrow("missing events");
    }
  });
  test("preserves unknown properties and creates one scoped exception", () => {
    const changed = updateEvent(
      sample,
      {
        summary: "Changed",
        start: "2026-10-15T12:00:00Z",
        end: "2026-10-15T13:00:00Z",
      },
      "occurrence",
      "2026-10-15T10:00:00Z",
    );
    const calendar = calendarData(changed);
    const events = calendar.getAllSubcomponents("vevent");
    expect(events).toHaveLength(2);
    expect(events[0].getFirstPropertyValue("summary")).toBe("Test");
    expect(events[1].getFirstPropertyValue("summary")).toBe("Changed");
    expect(events[1].getFirstPropertyValue("recurrence-id").toString()).toBe(
      "2026-10-15T10:00:00Z",
    );
    expect(events[1].hasProperty("rrule")).toBe(false);
    expect(changed).toContain("X-APPLE-CUSTOM:keep-me");
    expect(() =>
      updateEvent(changed, { recurrenceRule: "FREQ=WEEKLY" }, "series"),
    ).toThrow("unsafe");
  });
  test("delete occurrence adds EXDATE and keeps other exceptions", () => {
    const changed = updateEvent(
      sample,
      { summary: "other exception" },
      "occurrence",
      "2026-10-16T10:00:00Z",
    );
    const excluded = excludeOccurrence(changed, "2026-10-15T10:00:00Z");
    expect(excluded).toContain("EXDATE:20261015T100000Z");
    expect(excluded).toContain("other exception");
    expect(() => excludeOccurrence(sample, "2026-10-20T10:00:00Z")).toThrow(
      "not in the series",
    );
  });
  test("supports all-day date editing with exclusive DTEND", () => {
    const allDay = sample
      .replace("DTSTART:20261014T100000Z", "DTSTART;VALUE=DATE:20261014")
      .replace("DTEND:20261014T110000Z", "DTEND;VALUE=DATE:20261015");
    const changed = updateEvent(
      allDay,
      { start: "2026-10-16", end: "2026-10-17" },
      "series",
    );
    expect(changed).toContain("DTSTART;VALUE=DATE:20261016");
    expect(changed).toContain("DTEND;VALUE=DATE:20261017");
  });
  test("requires a definition for TZID and rejects floating availability", () => {
    expect(() =>
      calendarData(
        sample.replace(
          "DTSTART:20261014T100000Z",
          "DTSTART;TZID=Europe/Berlin:20261014T100000",
        ),
      ),
    ).toThrow("VTIMEZONE");
    expect(() =>
      busyIntervals(
        [{ id: "one", etag: '"v1"', ics: sample }],
        "2026-10-14T00:00:00Z",
        "2026-10-15T00:00:00Z",
      ),
    ).toThrow("did not expand");
    const floating = sample
      .replace("RRULE:FREQ=DAILY;COUNT=3\r\n", "")
      .replaceAll("T100000Z", "T100000")
      .replaceAll("T110000Z", "T110000");
    expect(() =>
      busyIntervals(
        [{ id: "one", etag: "", ics: floating }],
        "2026-10-14T00:00:00Z",
        "2026-10-15T00:00:00Z",
      ),
    ).toThrow("floating");
  });
  test("computes clipped UTC busy intervals for expanded data", () => {
    const expanded = sample.replace("RRULE:FREQ=DAILY;COUNT=3\r\n", "");
    expect(
      busyIntervals(
        [{ id: "one", etag: "", ics: expanded }],
        "2026-10-14T10:30:00Z",
        "2026-10-14T12:00:00Z",
      ),
    ).toEqual([
      {
        start: "2026-10-14T10:30:00.000Z",
        end: "2026-10-14T11:00:00.000Z",
        eventId: "one",
      },
    ]);
  });
  test("disallows unsafe occurrence rule edits and non-REPLY scheduling", () => {
    expect(() =>
      updateEvent(
        sample,
        { recurrenceRule: "FREQ=WEEKLY" },
        "occurrence",
        "2026-10-15T10:00:00Z",
      ),
    ).toThrow("series scope");
    expect(() => validateReply(sample)).toThrow("METHOD:REPLY");
  });
});
const berlinZone =
  "BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n";
test("embedded timezone survives exception edits across DST and resolves availability", () => {
  const local = sample
    .replace("BEGIN:VEVENT", `${berlinZone}BEGIN:VEVENT`)
    .replace(
      "DTSTART:20261014T100000Z",
      "DTSTART;TZID=Europe/Berlin:20261024T100000",
    )
    .replace(
      "DTEND:20261014T110000Z",
      "DTEND;TZID=Europe/Berlin:20261024T110000",
    );
  const changed = updateEvent(
    local,
    {
      summary: "DST exception",
      start: "2026-10-25T12:00:00",
      end: "2026-10-25T13:00:00",
      timezone: "Europe/Berlin",
    },
    "occurrence",
    "2026-10-25T10:00:00",
  );
  expect(changed).toContain("RECURRENCE-ID;TZID=Europe/Berlin:20261025T100000");
  expect(changed).toContain("DTSTART;TZID=Europe/Berlin:20261025T120000");
  expect(changed).toContain("BEGIN:VTIMEZONE");
  const after = local
    .replace("RRULE:FREQ=DAILY;COUNT=3\r\n", "")
    .replaceAll("20261024T", "20261026T");
  expect(
    busyIntervals(
      [{ id: "dst", etag: "", ics: after }],
      "2026-10-26T00:00:00Z",
      "2026-10-27T00:00:00Z",
    )[0],
  ).toMatchObject({
    start: "2026-10-26T09:00:00.000Z",
    end: "2026-10-26T10:00:00.000Z",
  });
  expect(() =>
    updateEvent(
      changed,
      { start: "2026-10-26T10:00:00", end: "2026-10-26T11:00:00" },
      "series",
    ),
  ).toThrow("unsafe");
});
test("scheduling replies validate owner identity and expose recipient failure", async () => {
  const reply = sample
    .replace("PRODID:", "METHOD:REPLY\r\nPRODID:")
    .replace("RRULE:FREQ=DAILY;COUNT=3\r\n", "")
    .replace(
      "SUMMARY:Test",
      "ORGANIZER:mailto:organizer@example.invalid\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:synthetic@example.invalid\r\nSUMMARY:Test",
    );
  expect(validateReply(reply)).toBe("mailto:synthetic@example.invalid");
  const mock = fixture((url, init) => {
    if (url.endsWith("/principal/"))
      return new Response(
        xml(
          "<c:calendar-home-set><d:href>/u/</d:href></c:calendar-home-set><c:schedule-outbox-URL><d:href>/u/outbox/</d:href></c:schedule-outbox-URL><c:calendar-user-address-set><d:href>mailto:synthetic@example.invalid</d:href></c:calendar-user-address-set>",
        ),
        { status: 207 },
      );
    if (init.method === "POST")
      return new Response(
        '<c:schedule-response xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:"><c:response><c:recipient><d:href>mailto:organizer@example.invalid</d:href></c:recipient><c:request-status>3.7;Invalid calendar user</c:request-status></c:response></c:schedule-response>',
      );
  });
  const dav = new CalDAV(env, mock as typeof fetch);
  await expect(
    dav.schedule(reply, "mailto:someone-else@example.invalid"),
  ).rejects.toThrow("authenticated owner");
  const statuses = await dav.schedule(reply, validateReply(reply));
  expect(statuses[0].status).toBe("3.7;Invalid calendar user");
  expect(statuses[0].status.startsWith("2.")).toBe(false);
});

test("numeric XML line endings retain calendar versions and event data", () => {
  const data = sample.replace(/\r/g, "&#13;");
  const rows = parseDav(
    xml(
      `<d:getetag>"v1"</d:getetag><c:calendar-data>${data}</c:calendar-data>`,
    ),
  );
  expect(rows[0].props["calendar-data"]).toBe(sample);
  expect(calendarData(String(rows[0].props["calendar-data"]))).toBeTruthy();
});
test("event read uses REPORT ETag and matching resource, never weak GET ETags", async () => {
  const mock = fixture();
  const dav = new CalDAV(env, mock as typeof fetch);
  expect(await dav.read(calendar + "event-one.ics")).toMatchObject({
    etag: '"v1"',
    ics: sample,
  });
  expect(mock.mock.calls.some(([, init]) => init?.method === "GET")).toBe(
    false,
  );
});

test("iCloud expanded responses may omit VERSION without losing UTC intervals", () => {
  const expanded = sample
    .replace("VERSION:2.0\r\n", "")
    .replace("RRULE:FREQ=DAILY;COUNT=3\r\n", "");
  expect(
    busyIntervals(
      [{ id: calendar + "one.ics", etag: '"v1"', ics: expanded }],
      "2026-10-14T00:00:00Z",
      "2026-10-15T00:00:00Z",
    ),
  ).toEqual([
    {
      start: "2026-10-14T10:00:00.000Z",
      end: "2026-10-14T11:00:00.000Z",
      eventId: calendar + "one.ics",
    },
  ]);
});
test("MOVE uses conditional atomic request and never copy/delete fallback", async () => {
  const calls: string[] = [];
  class MovingDAV extends CalDAV {
    async eventURL(id: string) {
      return id;
    }
    async calendar(id: string) {
      return {
        id,
        name: "Test",
        description: "",
        etag: "",
        privileges: ["write"],
        reports: [],
        components: ["VEVENT"],
        supportsEvents: true,
      };
    }
    async read(id: string) {
      return { id, etag: '"v1"', ics: sample };
    }
    async request(
      url: string,
      method: string,
      body?: string,
      headers: Record<string, string> = {},
    ) {
      calls.push(method);
      expect(headers["If-Match"]).toBe('"v1"');
      expect(headers.Overwrite).toBe("F");
      expect(headers.Destination).toBe(origin + "/u/second/one.ics");
      throw new CalendarError("Unsupported", 403);
    }
  }
  await expect(
    new MovingDAV(env).move(
      calendar + "one.ics",
      origin + "/u/second/",
      '"v1"',
    ),
  ).rejects.toThrow("Unsupported");
  expect(calls).toEqual(["MOVE"]);
});
test("VTODO-only collections are visible but reject event operations before writing", async () => {
  const mock = fixture((url, init) =>
    url === origin + "/u/"
      ? new Response(
          xml(
            '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>',
          ),
          { status: 207 },
        )
      : undefined,
  );
  const dav = new CalDAV(env, mock as typeof fetch);
  expect((await dav.discover()).calendars[0]).toMatchObject({
    components: ["VTODO"],
    supportsEvents: false,
  });
  await expect(dav.create(calendar, "one", sample)).rejects.toThrow(
    "does not support VEVENT",
  );
  expect(mock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
    false,
  );
});
test("expanded timezone hydration uses same-version original definitions", async () => {
  const full = sample
    .replace("BEGIN:VEVENT", berlinZone + "BEGIN:VEVENT")
    .replace("RRULE:FREQ=DAILY;COUNT=3\r\n", "")
    .replace(
      "DTSTART:20261014T100000Z",
      "DTSTART;TZID=Europe/Berlin:20261014T100000",
    )
    .replace(
      "DTEND:20261014T110000Z",
      "DTEND;TZID=Europe/Berlin:20261014T110000",
    );
  const original = { id: calendar + "tz.ics", etag: '"v1"', ics: full };
  const expanded = {
    ...original,
    ics: full.replace(berlinZone, "").replace("VERSION:2.0\r\n", ""),
  };
  const resources = await expandedTimezones([expanded], async () => original);
  expect(
    busyIntervals(resources, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z")[0]
      .start,
  ).toBe("2026-10-14T08:00:00.000Z");
  await expect(
    expandedTimezones([expanded], async () => ({ ...original, etag: '"v2"' })),
  ).rejects.toThrow("changed");
});

test("calendar creation uses Workers-supported extended MKCOL with calendar resource type", async () => {
  let createdId = "";
  const mock = fixture((url, init) => {
    if (init.method === "MKCOL") {
      createdId = url;
      expect(String(init.body)).toContain(
        "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
      );
      expect(String(init.body)).toContain("<d:mkcol");
      return new Response(null, { status: 201 });
    }
    if (createdId && url === origin + "/u/")
      return new Response(
        xml(
          "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Fixture</d:displayname>",
          new URL(createdId).pathname,
        ),
        { status: 207 },
      );
  });
  expect(
    (await new CalDAV(env, mock as typeof fetch).createCalendar("Fixture")).id,
  ).toBe(createdId);
  expect(
    mock.mock.calls.some(([, init]) => init?.method === "MKCALENDAR"),
  ).toBe(false);
});
