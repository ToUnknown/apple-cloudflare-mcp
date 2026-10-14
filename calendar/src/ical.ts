import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarError, type Resource } from "./caldav";
export const DEFAULT_TIMEZONE = "Europe/Berlin";
type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;
export interface Patch {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timezone?: string;
  recurrenceRule?: string | null;
}
export function calendarData(ics: string): Component {
  if (new TextEncoder().encode(ics).length > 1_000_000)
    throw new CalendarError("ICS is too large");
  let calendar: Component;
  try {
    calendar = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new CalendarError("Invalid iCalendar data");
  }
  if (
    calendar.name !== "vcalendar" ||
    calendar.getFirstPropertyValue("version") !== "2.0"
  )
    throw new CalendarError("Expected a VERSION:2.0 VCALENDAR");
  const events = calendar.getAllSubcomponents("vevent");
  if (
    !events.length ||
    events.length > 500 ||
    calendar
      .getAllSubcomponents()
      .some((c) => !["vevent", "vtimezone"].includes(c.name))
  )
    throw new CalendarError(
      "Expected at most 500 VEVENTs and optional VTIMEZONEs",
    );
  const uids = new Set(events.map((e) => e.getFirstPropertyValue("uid")));
  if (uids.size !== 1 || typeof [...uids][0] !== "string" || ![...uids][0])
    throw new CalendarError(
      "One UID (series and its exceptions) per resource is required",
    );
  const masters = events.filter((e) => !e.hasProperty("recurrence-id"));
  if (masters.length !== 1)
    throw new CalendarError("One master VEVENT is required");
  for (const event of events) {
    if (!event.hasProperty("dtstart"))
      throw new CalendarError("Every VEVENT requires DTSTART");
    if (event.hasProperty("dtend") && event.hasProperty("duration"))
      throw new CalendarError("DTEND and DURATION cannot both be set");
    if (event.getFirstProperty("recurrence-id")?.getParameter("range"))
      throw new CalendarError(
        "RANGE=THISANDFUTURE exceptions are unsupported for edits",
      );
    const parsed = new ICAL.Event(event);
    const start = parsed.startDate,
      end = parsed.endDate;
    if (start.isDate !== end.isDate || end.compare(start) < 0)
      throw new CalendarError("Invalid event end or mixed date types");
    for (const field of ["dtstart", "dtend", "recurrence-id"]) {
      const property = event.getFirstProperty(field);
      const tzid = property?.getParameter("tzid");
      if (tzid && tzid !== "UTC" && !calendar.getTimeZoneByID(String(tzid)))
        throw new CalendarError(
          "Non-UTC TZID requires its VTIMEZONE definition",
        );
    }
  }
  return calendar;
}
export function filterByTitle(
  resources: Resource[],
  text?: string,
): Resource[] {
  if (text === undefined) return resources;
  const normalize = (value: string) => value.normalize("NFC").toUpperCase();
  const needle = normalize(text);
  return resources.filter((resource) => {
    let calendar: Component;
    try {
      calendar = new ICAL.Component(ICAL.parse(resource.ics));
    } catch {
      throw new CalendarError(
        "Cannot verify title matches: invalid calendar data",
      );
    }
    const events = calendar.getAllSubcomponents("vevent");
    if (calendar.name !== "vcalendar" || !events.length)
      throw new CalendarError(
        "Cannot verify title matches: calendar has no events",
      );
    // Decode folded/escaped text through ICAL; never match descriptions or alarm titles.
    return events.some((event) => {
      const title = event.getFirstPropertyValue("summary");
      return typeof title === "string" && normalize(title).includes(needle);
    });
  });
}
export function eventDetails(resource: Resource): unknown {
  let calendar: Component;
  try {
    calendar = calendarData(resource.ics);
  } catch (error) {
    return {
      ...resource,
      expanded: false,
      detailsUnavailable:
        error instanceof CalendarError
          ? error.message
          : "Unrecognized iCalendar data; raw ICS is preserved",
    };
  }
  return {
    ...resource,
    expanded: false,
    uid: calendar.getFirstSubcomponent("vevent")!.getFirstPropertyValue("uid"),
    events: calendar.getAllSubcomponents("vevent").map((event) => {
      const e = new ICAL.Event(event);
      return {
        summary: e.summary,
        description: e.description,
        location: e.location,
        start: e.startDate.toString(),
        end: e.endDate.toString(),
        allDay: e.startDate.isDate,
        timezone: e.startDate.zone.tzid,
        recurrenceId:
          event.getFirstPropertyValue("recurrence-id")?.toString() ?? null,
        recurring: e.isRecurring(),
        organizer: event.getFirstPropertyValue("organizer"),
        attendees: event.getAllProperties("attendee").map((p) => p.toJSON()),
        recurrenceRules: event
          .getAllProperties("rrule")
          .map((p) => p.toICALString()),
        excludedDates: event
          .getAllProperties("exdate")
          .map((p) => p.toICALString()),
      };
    }),
  };
}
export function uidOf(ics: string): string {
  return String(
    calendarData(ics)
      .getFirstSubcomponent("vevent")!
      .getFirstPropertyValue("uid"),
  );
}
function copy(component: Component): Component {
  return new ICAL.Component(JSON.parse(JSON.stringify(component.toJSON())));
}
function recurrenceTime(master: Component, recurrenceId: string): Time {
  const property = master.getFirstProperty("dtstart")!;
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\dZ?)?$/.test(recurrenceId))
    throw new CalendarError(
      "recurrenceId must use the original DTSTART date/time and timezone",
    );
  const time = ICAL.Time.fromString(recurrenceId, property);
  const start = master.getFirstPropertyValue("dtstart") as Time;
  if (time.isDate !== start.isDate || time.zone.tzid !== start.zone.tzid)
    throw new CalendarError(
      "Occurrence identity must match the series date type and timezone",
    );
  const iterator = new ICAL.Event(master).iterator();
  for (let n = 0; n < 10_000; n++) {
    const candidate = iterator.next();
    if (!candidate || candidate.compare(time) > 0) break;
    if (candidate.compare(time) === 0) return time;
  }
  throw new CalendarError(
    "Occurrence is not in the series, or beyond the 10000-occurrence validation bound",
  );
}
function setTime(
  event: Component,
  calendar: Component,
  field: "dtstart" | "dtend",
  value: string,
  timezone?: string,
): void {
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\dZ?)?$/.test(value))
    throw new CalendarError(
      "Use ISO date, UTC datetime, or local datetime with a timezone",
    );
  const property = new ICAL.Property(field);
  if (value.length > 10 && !value.endsWith("Z")) {
    const zone =
      timezone ??
      String(event.getFirstProperty(field)?.getParameter("tzid") ?? "");
    if (!zone || !calendar.getTimeZoneByID(zone))
      throw new CalendarError(
        "Local datetime needs a TZID with an embedded VTIMEZONE; use UTC or import full ICS",
      );
    property.setParameter("tzid", zone);
  }
  // Attach before decoding so ICAL resolves the embedded VTIMEZONE through its parent.
  event.removeAllProperties(field);
  event.addProperty(property);
  const parsed = ICAL.Time.fromString(value, property);
  if (parsed.toString() !== value)
    throw new CalendarError("Invalid calendar date or time");
  property.setValue(parsed);
}
function touched(event: Component): void {
  event.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  event.updatePropertyWithValue(
    "last-modified",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  event.updatePropertyWithValue(
    "sequence",
    Number(event.getFirstPropertyValue("sequence") ?? 0) + 1,
  );
}
export function updateEvent(
  ics: string,
  patch: Patch,
  scope: "series" | "occurrence",
  recurrenceId?: string,
): string {
  const calendar = calendarData(ics);
  const master = calendar
    .getAllSubcomponents("vevent")
    .find((e) => !e.hasProperty("recurrence-id"))!;
  if (scope === "series" && recurrenceId)
    throw new CalendarError("recurrenceId is only valid with occurrence scope");
  if (scope === "occurrence" && patch.recurrenceRule !== undefined)
    throw new CalendarError(
      "Recurrence rules can only be changed with series scope",
    );
  if (
    patch.timezone !== undefined &&
    patch.start === undefined &&
    patch.end === undefined
  )
    throw new CalendarError("Timezone requires a start or end patch");
  if (
    scope === "series" &&
    (patch.start !== undefined || patch.end !== undefined) &&
    calendar
      .getAllSubcomponents("vevent")
      .some((e) => e.hasProperty("recurrence-id"))
  )
    throw new CalendarError(
      "Changing series times with existing exceptions is unsafe; export and import a deliberately rebuilt series",
    );
  let event = master;
  if (scope === "occurrence") {
    if (!recurrenceId)
      throw new CalendarError("Occurrence scope requires recurrenceId");
    const original = recurrenceTime(master, recurrenceId);
    event =
      calendar
        .getAllSubcomponents("vevent")
        .find(
          (e) =>
            e.getFirstPropertyValue("recurrence-id")?.toString() ===
            recurrenceId,
        ) ?? copy(master);
    if (event !== master && !event.hasProperty("recurrence-id")) {
      for (const name of ["rrule", "rdate", "exrule", "exdate"])
        event.removeAllProperties(name);
      const originalEnd = new ICAL.Event(master).endDate;
      const duration = originalEnd.subtractDate(
        master.getFirstPropertyValue("dtstart") as Time,
      );
      const end = original.clone();
      end.addDuration(duration);
      event.updatePropertyWithValue("dtstart", original.clone());
      event.removeAllProperties("duration");
      event.updatePropertyWithValue("dtend", end);
      const rid = event.addPropertyWithValue("recurrence-id", original.clone());
      const tzid = master.getFirstProperty("dtstart")!.getParameter("tzid");
      if (tzid) rid.setParameter("tzid", tzid);
      calendar.addSubcomponent(event);
    }
  }
  for (const field of ["summary", "description", "location"] as const)
    if (patch[field] !== undefined)
      event.updatePropertyWithValue(field, patch[field]);
  if (patch.start !== undefined)
    setTime(event, calendar, "dtstart", patch.start, patch.timezone);
  if (patch.end !== undefined) {
    event.removeAllProperties("duration");
    setTime(event, calendar, "dtend", patch.end, patch.timezone);
  }
  if (patch.recurrenceRule !== undefined) {
    if (
      calendar
        .getAllSubcomponents("vevent")
        .some((e) => e.hasProperty("recurrence-id"))
    )
      throw new CalendarError(
        "Changing a rule with existing exceptions is unsafe; export and import a deliberately rebuilt series",
      );
    event.removeAllProperties("rrule");
    if (patch.recurrenceRule)
      event.addPropertyWithValue(
        "rrule",
        ICAL.Recur.fromString(patch.recurrenceRule),
      );
  }
  touched(event);
  const output = calendar.toString();
  calendarData(output);
  return output;
}
export function excludeOccurrence(ics: string, recurrenceId: string): string {
  const calendar = calendarData(ics);
  const master = calendar
    .getAllSubcomponents("vevent")
    .find((e) => !e.hasProperty("recurrence-id"))!;
  const time = recurrenceTime(master, recurrenceId);
  for (const event of calendar.getAllSubcomponents("vevent"))
    if (
      event.getFirstPropertyValue("recurrence-id")?.toString() === recurrenceId
    )
      calendar.removeSubcomponent(event);
  const property = master.addPropertyWithValue("exdate", time);
  const tzid = master.getFirstProperty("dtstart")!.getParameter("tzid");
  if (tzid) property.setParameter("tzid", tzid);
  touched(master);
  return calendar.toString();
}
// iCloud's expanded calendar-data can retain TZIDs while omitting VTIMEZONE.
// Restore definitions only from the same resource version, never guess a zone.
export async function expandedTimezones(
  resources: Resource[],
  read: (id: string) => Promise<Resource>,
): Promise<Resource[]> {
  const result: Resource[] = [];
  for (const resource of resources) {
    const expanded = new ICAL.Component(ICAL.parse(resource.ics));
    const missing = new Set<string>();
    for (const event of expanded.getAllSubcomponents("vevent")) {
      for (const field of ["dtstart", "dtend"]) {
        const zone = event.getFirstProperty(field)?.getParameter("tzid");
        if (zone && zone !== "UTC" && !expanded.getTimeZoneByID(String(zone)))
          missing.add(String(zone));
      }
    }
    if (!missing.size) {
      result.push(resource);
      continue;
    }
    const original = await read(resource.id);
    if (original.etag !== resource.etag)
      throw new CalendarError("Event changed during availability check; retry");
    const calendar = calendarData(original.ics);
    for (const zone of missing) {
      const definition = calendar
        .getAllSubcomponents("vtimezone")
        .find((component) => component.getFirstPropertyValue("tzid") === zone);
      if (!definition)
        throw new CalendarError(
          "Availability requires full timezone definitions",
        );
      expanded.addSubcomponent(
        new ICAL.Component(ICAL.parse(definition.toString())),
      );
    }
    result.push({ ...resource, ics: expanded.toString() });
  }
  return result;
}
function defaultZonedTime(time: Time): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from(
    {
      timeZone: DEFAULT_TIMEZONE,
      year: time.year,
      month: time.month,
      day: time.day,
      hour: time.isDate ? 0 : time.hour,
      minute: time.isDate ? 0 : time.minute,
      second: time.isDate ? 0 : time.second,
    },
    { disambiguation: "compatible", overflow: "reject" },
  );
}
export function availabilityTime(time: Time): number {
  return time.isDate || time.zone.tzid === "floating"
    ? defaultZonedTime(time).epochMilliseconds
    : time.toUnixTime() * 1000;
}
export function busyIntervals(
  resources: Resource[],
  start: string,
  end: string,
): { start: string; end: string; eventId: string }[] {
  const result: { start: string; end: string; eventId: string }[] = [];
  for (const resource of resources) {
    // Expanded resources may contain only RECURRENCE-ID components; validate with the parser, not the writable-resource validator.
    let calendar: Component;
    try {
      calendar = new ICAL.Component(ICAL.parse(resource.ics));
    } catch {
      throw new CalendarError("Invalid expanded calendar data");
    }
    if (
      calendar.name !== "vcalendar" ||
      (calendar.hasProperty("version") &&
        calendar.getFirstPropertyValue("version") !== "2.0") ||
      !calendar.getAllSubcomponents("vevent").length
    )
      throw new CalendarError(
        "Expanded calendar data is missing events or has an unsupported version",
      );
    for (const component of calendar.getAllSubcomponents("vevent")) {
      if (!component.hasProperty("dtstart"))
        throw new CalendarError("Expanded event is missing DTSTART");
      if (component.hasProperty("rrule") || component.hasProperty("rdate"))
        throw new CalendarError(
          "Server did not expand recurrence; availability cannot be computed reliably",
        );
      if (
        component.getFirstPropertyValue("status") === "CANCELLED" ||
        component.getFirstPropertyValue("transp") === "TRANSPARENT"
      )
        continue;
      const event = new ICAL.Event(component);
      for (const field of ["dtstart", "dtend"]) {
        const tzid = component.getFirstProperty(field)?.getParameter("tzid");
        if (tzid && tzid !== "UTC" && !calendar.getTimeZoneByID(String(tzid)))
          throw new CalendarError(
            "Availability requires full timezone definitions",
          );
      }
      const begins = availabilityTime(event.startDate);
      let ends = availabilityTime(event.endDate);
      // Calendar days follow local midnight; hour durations are elapsed hours across DST.
      if (
        !component.hasProperty("dtend") &&
        component.hasProperty("duration") &&
        (event.startDate.isDate || event.startDate.zone.tzid === "floating")
      ) {
        const duration = event.duration;
        const sign = duration.isNegative ? -1 : 1;
        ends = defaultZonedTime(event.startDate).add({
          weeks: sign * duration.weeks,
          days: sign * duration.days,
          hours: sign * duration.hours,
          minutes: sign * duration.minutes,
          seconds: sign * duration.seconds,
        }).epochMilliseconds;
      }
      if (ends < begins)
        throw new CalendarError(
          "Event end precedes its start under the timezone policy",
        );
      const first = Math.max(begins, Date.parse(start)),
        last = Math.min(ends, Date.parse(end));
      if (last > first)
        result.push({
          start: new Date(first).toISOString(),
          end: new Date(last).toISOString(),
          eventId: resource.id,
        });
    }
  }
  return result.sort((a, b) => a.start.localeCompare(b.start));
}
export function validateReply(ics: string): string {
  if (new TextEncoder().encode(ics).length > 1_000_000)
    throw new CalendarError("ICS is too large");
  let calendar: Component;
  try {
    calendar = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new CalendarError("Invalid scheduling ICS");
  }
  if (
    calendar.name !== "vcalendar" ||
    calendar.getFirstPropertyValue("method") !== "REPLY"
  )
    throw new CalendarError("Scheduling requires METHOD:REPLY");
  const events = calendar.getAllSubcomponents("vevent");
  if (
    events.length !== 1 ||
    !events[0].hasProperty("uid") ||
    !events[0].hasProperty("organizer") ||
    !events[0].hasProperty("dtstamp") ||
    events[0].getAllProperties("attendee").length !== 1
  )
    throw new CalendarError(
      "A reply needs one VEVENT with UID, DTSTAMP, ORGANIZER, and your ATTENDEE",
    );
  if (
    !["ACCEPTED", "DECLINED", "TENTATIVE"].includes(
      String(events[0].getFirstProperty("attendee")?.getParameter("partstat")),
    )
  )
    throw new CalendarError(
      "Reply PARTSTAT must be ACCEPTED, DECLINED, or TENTATIVE",
    );
  return String(events[0].getFirstPropertyValue("attendee"));
}
