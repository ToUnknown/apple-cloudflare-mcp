import { describe, test, expect, vi } from "vitest";
import { occurrenceSearch } from "../src/search";
import { simpleEvent } from "../src/simple";
import { eventDetails } from "../src/ical";
import {
  createOnce,
  canonical,
  type CreationRecord,
  type CreationStore,
} from "../src/creation";
const id = "https://p01-caldav.icloud.com/u/cal/test.ics";
const wrap = (events: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`;
const event = (fields: string) =>
  `BEGIN:VEVENT\r\nUID:test\r\nDTSTAMP:20261014T000000Z\r\n${fields}\r\nEND:VEVENT\r\n`;
const resource = (ics: string, etag = '"one"') => ({ id, etag, ics });
const master = event(
  "DTSTART:20261118T100000Z\r\nDTEND:20261118T103000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nSUMMARY:Master\r\nCREATED:20260101T090000Z",
);
const occurrence = (date: string, title = "Master", extra = "") =>
  event(
    `DTSTART:${date}T100000Z\r\nDTEND:${date}T103000Z\r\nRECURRENCE-ID:${date}T100000Z\r\nSUMMARY:${title}${extra}`,
  );
function search(
  expanded: string,
  original = master,
  text?: string,
  start = "2026-11-18T00:00:00Z",
  end = "2026-11-23T00:00:00Z",
) {
  return occurrenceSearch(
    [resource(wrap(expanded))],
    [resource(wrap(original))],
    start,
    end,
    text,
  );
}
describe("agent occurrence search", () => {
  test("returns actual moved dates with original identity and compact series metadata", () => {
    const moved = event(
      "DTSTART:20261122T120000Z\r\nDTEND:20261122T123000Z\r\nRECURRENCE-ID:20261119T100000Z\r\nSUMMARY:Moved title",
    );
    const out = search(occurrence("20261118") + moved, master + moved);
    expect(out.expanded).toBe(true);
    expect(out.resources[0].series).toMatchObject({
      start: "2026-11-18T10:00:00Z",
      createdAt: "2026-01-01T09:00:00Z",
      recurring: true,
    });
    expect(out.resources[0].series.recurrenceRules[0]).toMatchObject({
      frequency: "daily",
      count: 5,
    });
    expect(out.resources[0].events[1]).toMatchObject({
      start: "2026-11-22T12:00:00.000Z",
      recurrenceId: "2026-11-19T10:00:00Z",
      summary: "Moved title",
    });
    expect(out.resources[0].events[1]).toMatchObject({
      localStart: "2026-11-22T13:00:00+01:00",
      localEnd: "2026-11-22T13:30:00+01:00",
    });
    expect(out.resources[0]).not.toHaveProperty("ics");
  });
  test("matches actual occurrence title, skips cancelled and respects actual range", () => {
    const expanded =
      occurrence("20261118") +
      occurrence("20261119", "Exception") +
      occurrence("20261120", "Exception", "\r\nSTATUS:CANCELLED") +
      occurrence("20261124", "Exception");
    expect(
      search(expanded, master, "eXcEpTiOn").resources[0].events,
    ).toHaveLength(1);
    expect(search(expanded, master, "Master").resources[0].events).toHaveLength(
      1,
    );
    expect(search(expanded, master, "missing").resources).toEqual([]);
  });
  test("missing CREATED stays null and unexpanded or stale data fails closed", () => {
    expect(
      search(
        occurrence("20261118"),
        master.replace("CREATED:20260101T090000Z\r\n", ""),
      ).resources[0].series.createdAt,
    ).toBeNull();
    expect(() => search(master)).toThrow(/expand/i);
    expect(() =>
      occurrenceSearch(
        [resource(wrap(occurrence("20261118")), '"two"')],
        [resource(wrap(master))],
        "2026-11-18T00:00:00Z",
        "2026-11-23T00:00:00Z",
      ),
    ).toThrow(/ETag/);
  });
  test("end boundary is exclusive and large occurrence output is rejected", () => {
    expect(
      search(
        occurrence("20261118"),
        master,
        undefined,
        "2026-11-18T09:00:00Z",
        "2026-11-18T10:00:00Z",
      ).resources,
    ).toEqual([]);
    expect(() => search(occurrence("20261118").repeat(1001))).toThrow(
      /Too many/,
    );
  });
});
describe("ordinary event creation", () => {
  const details = (input: Parameters<typeof simpleEvent>[0]) =>
    eventDetails(resource(simpleEvent(input, "simple"))) as any;
  test("Berlin default respects summer/winter and explicit UTC offsets", () => {
    expect(
      details({
        title: "Winter",
        start: "2026-11-18T10:00:00",
        end: "2026-11-18T10:30:00",
      }).events[0].start,
    ).toBe("2026-11-18T09:00:00Z");
    expect(
      details({
        title: "Summer",
        start: "2026-07-15T10:00:00",
        end: "2026-07-15T10:30:00",
      }).events[0].start,
    ).toBe("2026-07-15T08:00:00Z");
    expect(
      details({
        title: "UTC",
        start: "2026-07-15T10:00:00Z",
        end: "2026-07-15T10:30:00Z",
      }).events[0].start,
    ).toBe("2026-07-15T10:00:00Z");
  });
  test("all-day end remains exclusive and invalid/DST-ambiguous inputs reject", () => {
    expect(
      details({
        title: "Day",
        allDay: true,
        start: "2026-03-29",
        end: "2026-03-30",
      }).events[0],
    ).toMatchObject({ allDay: true, start: "2026-03-29", end: "2026-03-30" });
    for (const start of ["2026-03-29T02:30:00", "2026-10-25T02:30:00"])
      expect(() =>
        simpleEvent({ title: "Gap", start, end: "2026-10-26T10:00:00" }, "x"),
      ).toThrow();
    expect(() =>
      simpleEvent(
        {
          title: "Bad",
          start: "2026-11-18T10:00:00Z",
          end: "2026-11-18T09:00:00Z",
        },
        "x",
      ),
    ).toThrow();
  });
});
function memoryStore(): CreationStore {
  let record: CreationRecord | null = null;
  return {
    async reserve(next) {
      const prior = record;
      if (!prior) record = next;
      return prior;
    },
    async complete(next) {
      record = next;
    },
    async receipt() {
      return record;
    },
  };
}
describe("durable creation identity", () => {
  const operationId = "25182d36-9e89-4479-b17f-1bdb827a8481";
  test("canonical retry replays receipt while changed payload conflicts", async () => {
    const store = memoryStore(),
      action = vi.fn(async () => ({ id, etag: '"one"' }));
    await createOnce(store, operationId, { title: "One", start: "x" }, action);
    expect(
      await createOnce(
        store,
        operationId,
        { start: "x", title: "One" },
        action,
      ),
    ).toMatchObject({ replayed: true, id });
    await expect(
      createOnce(store, operationId, { title: "Two" }, action),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect(action).toHaveBeenCalledTimes(1);
    expect(canonical({ a: undefined, b: 1 })).toBe(canonical({ b: 1 }));
  });
  test("concurrent duplicate cannot perform a second write while pending", async () => {
    const store = memoryStore();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = vi.fn(async () => {
      await wait;
      return { id };
    });
    const first = createOnce(store, operationId, { title: "One" }, action);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await expect(
      createOnce(store, operationId, { title: "One" }, action),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    release();
    await first;
    expect(action).toHaveBeenCalledTimes(1);
  });
  test("uncertain write is never repeated and missing receipt configuration rejects", async () => {
    const store = memoryStore(),
      action = vi.fn(async () => {
        throw new Error("network");
      });
    await expect(
      createOnce(store, operationId, {}, action),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    await expect(
      createOnce(store, operationId, {}, action),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    expect(action).toHaveBeenCalledTimes(1);
    await expect(
      createOnce(undefined, operationId, {}, action),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(
      createOnce(store, undefined, {}, action),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REQUIRED" });
  });
});
