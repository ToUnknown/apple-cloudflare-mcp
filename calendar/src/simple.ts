import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarError } from "./caldav";
import { DEFAULT_TIMEZONE, calendarData } from "./ical";
export interface SimpleEvent {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  timezone?: string;
  description?: string;
  location?: string;
}
export function simpleEvent(input: SimpleEvent, uid: string): string {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//Apple Cloudflare MCP//EN");
  const event = new ICAL.Component("vevent");
  calendar.addSubcomponent(event);
  event.addPropertyWithValue("uid", uid);
  const now = ICAL.Time.fromJSDate(new Date(), true);
  event.addPropertyWithValue("created", now);
  event.addPropertyWithValue("dtstamp", now);
  event.addPropertyWithValue("summary", input.title);
  for (const field of ["description", "location"] as const)
    if (input[field] !== undefined)
      event.addPropertyWithValue(field, input[field]);
  const convert = (value: string) => {
    if (input.allDay) {
      if (!/^\d{4}-\d\d-\d\d$/.test(value))
        throw new CalendarError(
          "All-day start/end require YYYY-MM-DD; end is exclusive",
        );
      Temporal.PlainDate.from(value, { overflow: "reject" });
      return value;
    }
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)?$/.test(value))
      throw new CalendarError(
        "Timed start/end require ISO datetime including seconds",
      );
    const time = /(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? Temporal.Instant.from(value)
      : Temporal.PlainDateTime.from(value)
          .toZonedDateTime(input.timezone ?? DEFAULT_TIMEZONE, {
            disambiguation: "reject",
          })
          .toInstant();
    return time.toString({ smallestUnit: "second" });
  };
  let start: string, end: string;
  try {
    start = convert(input.start);
    end = convert(input.end);
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError(
      "Invalid date/time or timezone; for ambiguous/nonexistent DST local times provide an explicit UTC offset",
    );
  }
  if (end <= start) throw new CalendarError("End must be after start");
  event.addPropertyWithValue(
    "dtstart",
    ICAL.Time.fromString(start, new ICAL.Property("dtstart")),
  );
  event.addPropertyWithValue(
    "dtend",
    ICAL.Time.fromString(end, new ICAL.Property("dtend")),
  );
  const ics = calendar.toString();
  calendarData(ics);
  return ics;
}
