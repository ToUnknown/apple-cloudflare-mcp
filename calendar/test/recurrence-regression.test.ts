import { expect, test } from "vitest";
import { occurrenceSearch } from "../src/search";
import { updateEvent } from "../src/ical";
const wrap = (s: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${s}END:VCALENDAR\r\n`;
const event = (s: string) =>
  `BEGIN:VEVENT\r\nUID:regression\r\nDTSTAMP:20261014T000000Z\r\n${s}\r\nEND:VEVENT\r\n`;
const r = (ics: string) => ({
  id: "https://p01-caldav.icloud.com/u/cal/test.ics",
  etag: '"one"',
  ics,
});
const master = event(
  "DTSTART:20261210T100000Z\r\nDTEND:20261210T103000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nSUMMARY:Master",
);
const moved = event(
  "RECURRENCE-ID:20261211T100000Z\r\nDTSTART:20261216T120000Z\r\nDTEND:20261216T123000Z\r\nSUMMARY:Moved",
);
test("narrow search finds moved exception even when provider range query omits its entire resource", () => {
  const result = occurrenceSearch(
    [],
    [r(wrap(master + moved))],
    "2026-12-16T00:00:00Z",
    "2026-12-17T00:00:00Z",
    "mOvEd",
  );
  expect(result.resources).toHaveLength(1);
  expect(result.resources[0].events[0]).toMatchObject({
    recurrenceId: "2026-12-11T10:00:00Z",
    start: "2026-12-16T12:00:00.000Z",
  });
});
test("all-day expanded datetime identity returns a DATE usable for an occurrence edit", () => {
  const original = wrap(
    event(
      "DTSTART;VALUE=DATE:20261220\r\nDTEND;VALUE=DATE:20261221\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Days",
    ),
  );
  const expanded = wrap(
    event(
      "DTSTART;VALUE=DATE:20261220\r\nDTEND;VALUE=DATE:20261221\r\nRECURRENCE-ID:20261220T000000Z\r\nSUMMARY:Days",
    ),
  );
  const result = occurrenceSearch(
    [r(expanded)],
    [r(original)],
    "2026-12-19T23:00:00Z",
    "2026-12-20T23:00:00Z",
  );
  const rid = result.resources[0].events[0].recurrenceId!;
  expect(rid).toBe("2026-12-20");
  expect(() =>
    updateEvent(original, { summary: "Changed" }, "occurrence", rid),
  ).not.toThrow();
});

test("moved all-day exceptions overlap Berlin midnight and retain DATE identity", () => {
  const m = event(
    "DTSTART;VALUE=DATE:20261220\r\nDTEND;VALUE=DATE:20261221\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Days",
  );
  const x = event(
    "RECURRENCE-ID;VALUE=DATE:20261221\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261225\r\nSUMMARY:Moved",
  );
  const result = occurrenceSearch(
    [],
    [r(wrap(m + x))],
    "2026-12-23T23:15:00Z",
    "2026-12-23T23:45:00Z",
  );
  expect(result.resources[0].events[0]).toMatchObject({
    start: "2026-12-24",
    end: "2026-12-25",
    recurrenceId: "2026-12-21",
    allDay: true,
  });
});
test("stored override replaces provider phantom at original date and is not duplicated", () => {
  const old = event(
    "RECURRENCE-ID:20261211T100000Z\r\nDTSTART:20261211T100000Z\r\nDTEND:20261211T103000Z\r\nSUMMARY:Old",
  );
  const out = occurrenceSearch(
    [r(wrap(old + moved))],
    [r(wrap(master + moved))],
    "2026-12-10T00:00:00Z",
    "2026-12-17T00:00:00Z",
  );
  expect(out.resources[0].events).toHaveLength(1);
  expect(out.resources[0].events[0].summary).toBe("Moved");
  expect(
    occurrenceSearch(
      [r(wrap(old))],
      [r(wrap(master + moved))],
      "2026-12-11T00:00:00Z",
      "2026-12-12T00:00:00Z",
    ).resources,
  ).toEqual([]);
});
test("cancelled stored override removes stale expanded instance", () => {
  const old = event(
    "RECURRENCE-ID:20261211T100000Z\r\nDTSTART:20261211T100000Z\r\nDTEND:20261211T103000Z\r\nSUMMARY:Old",
  );
  expect(
    occurrenceSearch(
      [r(wrap(old))],
      [
        r(
          wrap(
            master +
              old.replace("SUMMARY:Old", "SUMMARY:Old\r\nSTATUS:CANCELLED"),
          ),
        ),
      ],
      "2026-12-11T00:00:00Z",
      "2026-12-12T00:00:00Z",
    ).resources,
  ).toEqual([]);
});
