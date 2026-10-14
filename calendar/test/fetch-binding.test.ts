import { it, expect } from "vitest";
import { CalDAV } from "../src/caldav";
it("calls the fetch capability without binding the DAV client as this", async () => {
  let receiver: unknown = "not called";
  const strictFetch = async function(this: unknown) {
    receiver = this;
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return new Response("", { status: 207 });
  } as typeof fetch;
  const client = new CalDAV({ ICLOUD_USERNAME: "synthetic", ICLOUD_APP_PASSWORD: "synthetic" }, strictFetch);
  await client.request("https://caldav.icloud.com/", "PROPFIND");
  expect(receiver).toBeUndefined();
});
