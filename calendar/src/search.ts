import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarError, type Resource } from "./caldav";
import { DEFAULT_TIMEZONE, availabilityTime } from "./ical";
type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const dayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
function parse(ics: string): Component {
  const c = new ICAL.Component(ICAL.parse(ics));
  if (c.name !== "vcalendar" || !c.getAllSubcomponents("vevent").length)
    throw new CalendarError("Invalid expanded calendar data");
  return c;
}
function zone(time: Time) {
  return time.isDate || time.zone.tzid === "floating"
    ? DEFAULT_TIMEZONE
    : time.zone.tzid;
}
function rules(master: Component) {
  return master.getAllProperties("rrule").map((p) => {
    const rule = p.getFirstValue() as InstanceType<typeof ICAL.Recur>;
    const days =
      rule.parts.BYDAY ??
      (rule.freq === "WEEKLY"
        ? [
            dayCodes[
              (master.getFirstPropertyValue("dtstart") as Time).dayOfWeek() - 1
            ],
          ]
        : []);
    return {
      rule: rule.toString(),
      frequency: rule.freq.toLowerCase(),
      interval: rule.interval,
      weekdays: days.map((day) => {
        const code = day.slice(-2);
        return {
          day: weekdays[dayCodes.indexOf(code)],
          ordinal: day.length > 2 ? Number(day.slice(0, -2)) : null,
        };
      }),
      count: rule.count,
      until: rule.until?.toString() ?? null,
      parts: rule.parts,
    };
  });
}
function instant(ms: number) {
  return new Date(ms).toISOString();
}
export function occurrenceSearch(
  expanded: Resource[],
  originals: Resource[],
  start: string,
  end: string,
  text?: string,
) {
  const source = new Map(originals.map((r) => [r.id, r]));
  const resources = [];
  let count = 0;
  const lower = Date.parse(start),
    upper = Date.parse(end);
  const needle = text?.normalize("NFC").toUpperCase();
  for (const resource of expanded) {
    const original = source.get(resource.id);
    if (!original || original.etag !== resource.etag)
      throw new CalendarError("ETag conflict during search; retry search");
    const full = parse(original.ics),
      calendar = parse(resource.ics);
    const masters = full
      .getAllSubcomponents("vevent")
      .filter((e) => !e.hasProperty("recurrence-id"));
    if (masters.length !== 1)
      throw new CalendarError("Search metadata requires one series master");
    const master = masters[0],
      masterEvent = new ICAL.Event(master);
    // iCloud sometimes retains TZID but strips its definition during expansion.
    for (const definition of full.getAllSubcomponents("vtimezone"))
      if (
        !calendar.getTimeZoneByID(
          String(definition.getFirstPropertyValue("tzid")),
        )
      )
        calendar.addSubcomponent(
          new ICAL.Component(ICAL.parse(definition.toString())),
        );
    const recurring = masterEvent.isRecurring();
    const events = [];
    for (const component of calendar.getAllSubcomponents("vevent")) {
      if (++count > 1000)
        throw new CalendarError("Too many occurrences; narrow the date range");
      if (
        !component.hasProperty("dtstart") ||
        ["rrule", "rdate", "exdate", "exrule"].some((p) =>
          component.hasProperty(p),
        )
      )
        throw new CalendarError(
          "Server did not expand recurrence; search cannot provide reliable occurrence dates",
        );
      if (
        component.getFirstPropertyValue("uid") !==
        master.getFirstPropertyValue("uid")
      )
        throw new CalendarError("Search returned mismatched series UID");
      if (component.getFirstPropertyValue("status") === "CANCELLED") continue;
      for (const field of ["dtstart", "dtend", "recurrence-id"]) {
        const tzid = component.getFirstProperty(field)?.getParameter("tzid");
        if (tzid && tzid !== "UTC" && !calendar.getTimeZoneByID(String(tzid)))
          throw new CalendarError("Search requires full timezone definitions");
      }
      const event = new ICAL.Event(component);
      const begins = availabilityTime(event.startDate);
      let ends = availabilityTime(event.endDate);
      if (event.startDate.isDate !== event.endDate.isDate)
        throw new CalendarError("Invalid mixed event date types");
      if (
        component.hasProperty("duration") &&
        !component.hasProperty("dtend") &&
        (event.startDate.isDate || event.startDate.zone.tzid === "floating")
      ) {
        const d = event.duration,
          sign = d.isNegative ? -1 : 1;
        ends = Temporal.Instant.fromEpochMilliseconds(begins)
          .toZonedDateTimeISO(DEFAULT_TIMEZONE)
          .add({
            weeks: sign * d.weeks,
            days: sign * d.days,
            hours: sign * d.hours,
            minutes: sign * d.minutes,
            seconds: sign * d.seconds,
          }).epochMilliseconds;
      }
      if (ends < begins)
        throw new CalendarError(
          "Event end precedes its start under the timezone policy",
        );
      if (
        !(begins === ends
          ? begins >= lower && begins < upper
          : begins < upper && ends > lower)
      )
        continue;
      const summary = event.summary ?? "";
      if (
        needle !== undefined &&
        !summary.normalize("NFC").toUpperCase().includes(needle)
      )
        continue;
      let rid = component.getFirstPropertyValue("recurrence-id") as Time | null;
      if (recurring && !rid) {
        if (begins !== availabilityTime(masterEvent.startDate))
          throw new CalendarError(
            "Expanded recurring event omitted occurrence identity",
          );
        rid = masterEvent.startDate;
      }
      // RFC expansion can convert RECURRENCE-ID to UTC. Restore master-local identity for edits.
      if (rid && !rid.isDate && masterEvent.startDate.zone.tzid !== "floating")
        rid = rid.convertToZone(masterEvent.startDate.zone);
      events.push({
        summary,
        start: event.startDate.isDate
          ? event.startDate.toString()
          : instant(begins),
        end: event.startDate.isDate ? event.endDate.toString() : instant(ends),
        allDay: event.startDate.isDate,
        timezone: zone(event.startDate),
        localStart: event.startDate.isDate
          ? event.startDate.toString()
          : Temporal.Instant.fromEpochMilliseconds(begins)
              .toZonedDateTimeISO(DEFAULT_TIMEZONE)
              .toString({ timeZoneName: "never" }),
        localEnd: event.startDate.isDate
          ? event.endDate.toString()
          : Temporal.Instant.fromEpochMilliseconds(ends)
              .toZonedDateTimeISO(DEFAULT_TIMEZONE)
              .toString({ timeZoneName: "never" }),
        startUtc: instant(begins),
        endUtc: instant(ends),
        recurrenceId: rid?.toString() ?? null,
        recurrenceTimezone: recurring ? zone(masterEvent.startDate) : null,
        recurring,
        location: event.location ?? null,
        status: component.getFirstPropertyValue("status") ?? "CONFIRMED",
      });
    }
    if (!events.length) continue;
    events.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    resources.push({
      id: resource.id,
      etag: resource.etag,
      uid: master.getFirstPropertyValue("uid"),
      expanded: true,
      series: {
        start: masterEvent.startDate.toString(),
        timezone: zone(masterEvent.startDate),
        createdAt: master.getFirstPropertyValue("created")?.toString() ?? null,
        recurring,
        recurrenceRules: rules(master),
        additionalDates: master
          .getAllProperties("rdate")
          .map((p) => p.toICALString()),
        excludedDates: master
          .getAllProperties("exdate")
          .map((p) => p.toICALString()),
      },
      events,
    });
  }
  resources.sort((a, b) =>
    a.events[0].startUtc.localeCompare(b.events[0].startUtc),
  );
  return {
    expanded: true,
    start,
    end,
    defaultTimezone: DEFAULT_TIMEZONE,
    endExclusive: true,
    resources,
  };
}
