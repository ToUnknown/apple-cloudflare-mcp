import { it, expect } from "vitest";
import { CardDAV } from "../src/carddav";
it("calls the fetch capability without binding the DAV client as this", async () => {
  let receiver: unknown = "not called";
  const strictFetch = async function(this: unknown) {
    receiver = this;
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return new Response("", { status: 207 });
  } as typeof fetch;
  const client = new CardDAV("synthetic", "synthetic", strictFetch);
  await client.request("https://contacts.icloud.com/", "PROPFIND");
  expect(receiver).toBeUndefined();
});
