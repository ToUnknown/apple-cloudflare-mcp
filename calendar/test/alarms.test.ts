import { expect, test } from "vitest";
import ICAL from "ical.js";
import { suppressDefaultAlerts, updateEvent } from "../src/ical";
import { simpleEvent } from "../src/simple";
const plain = simpleEvent(
  {
    title: "No default alert",
    start: "2026-12-28T12:00:00",
    end: "2026-12-28T12:30:00",
  },
  "alarm-test",
);
const events = (ics: string) =>
  new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents("vevent");
test("new events have one explicit NONE alarm and repeated processing is stable", () => {
  const out = suppressDefaultAlerts(plain);
  const alarms = events(out)[0].getAllSubcomponents("valarm");
  expect(alarms).toHaveLength(1);
  expect(alarms[0].getFirstPropertyValue("action")).toBe("NONE");
  expect(alarms[0].getFirstPropertyValue("trigger")?.toString()).toBe(
    "1976-04-01T00:55:45Z",
  );
  expect(suppressDefaultAlerts(out)).toBe(out);
  expect(
    events(updateEvent(out, { summary: "Edited" }, "series"))[0]
      .getAllSubcomponents("valarm")[0]
      .getFirstPropertyValue("action"),
  ).toBe("NONE");
});
test("explicit reminder survives exactly and recurring exceptions without alarms opt out", () => {
  const explicit = plain.replace(
    "END:VEVENT",
    "BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Requested reminder\r\nTRIGGER:-PT10M\r\nEND:VALARM\r\nEND:VEVENT",
  );
  expect(suppressDefaultAlerts(explicit)).toBe(explicit);
  const recurring = explicit.replace(
    "SUMMARY:No default alert",
    "RRULE:FREQ=DAILY;COUNT=2\r\nSUMMARY:No default alert",
  );
  const exception =
    "BEGIN:VEVENT\r\nUID:alarm-test\r\nDTSTAMP:20261014T000000Z\r\nRECURRENCE-ID:20261229T110000Z\r\nDTSTART:20261229T110000Z\r\nDTEND:20261229T113000Z\r\nSUMMARY:Exception\r\nEND:VEVENT\r\n";
  const result = events(
    suppressDefaultAlerts(
      recurring.replace("END:VCALENDAR", exception + "END:VCALENDAR"),
    ),
  );
  expect(
    result.map((e) =>
      e.getAllSubcomponents("valarm")[0].getFirstPropertyValue("action"),
    ),
  ).toEqual(["DISPLAY", "NONE"]);
});
test("all-day creation also explicitly disables the default", () => {
  const out = suppressDefaultAlerts(
    simpleEvent(
      { title: "Day", start: "2026-12-28", end: "2026-12-29", allDay: true },
      "day",
    ),
  );
  expect(
    events(out)[0]
      .getAllSubcomponents("valarm")[0]
      .getFirstPropertyValue("action"),
  ).toBe("NONE");
});
