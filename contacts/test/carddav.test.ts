import { describe, it, expect, vi } from "vitest";
import { CardDAV, appleURL, boundedText, multistatus } from "../src/carddav";
import { newCard } from "../src/vcard";
const host = "https://p123-contacts.icloud.com";
const book = host + "/123/carddavhome/card/";
const multi = (items: string) =>
  `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">${items}</d:multistatus>`;
const item = (href: string, props: string) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const discovery = [
  new Response(null, { status: 301, headers: { Location: host + "/" } }),
  new Response(
    multi(
      item(
        "/",
        "<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>",
      ),
    ),
    { status: 207 },
  ),
  new Response(
    multi(
      item(
        "/123/principal/",
        "<c:addressbook-home-set><d:href>/123/carddavhome/</d:href></c:addressbook-home-set>",
      ),
    ),
    { status: 207 },
  ),
  new Response(
    multi(
      item(
        book,
        "<d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>Contacts &amp; Friends</d:displayname>",
      ),
    ),
    { status: 207 },
  ),
];
function fixture(extra: Response[] = []) {
  const responses = [...discovery.map((r) => r.clone()), ...extra];
  const http = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  });
  return {
    dav: new CardDAV(
      "example@example.invalid",
      "not-a-real-password",
      http as typeof fetch,
    ),
    http,
  };
}
describe("CardDAV", () => {
  it("discovers principal and collection through allowlisted Apple redirect", async () => {
    const { dav, http } = fixture();
    expect(await dav.discover()).toEqual([
      { id: book, name: "Contacts & Friends" },
    ]);
    expect(http).toHaveBeenCalledTimes(4);
    expect(http.mock.calls[0]).toHaveLength(2);
  });
  it("never follows untrusted redirect with Apple authorization", async () => {
    const http = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.invalid/" },
        }),
    );
    const dav = new CardDAV("user", "secret", http as typeof fetch);
    await expect(dav.discover()).rejects.toThrow("Untrusted");
    expect(http).toHaveBeenCalledTimes(1);
    for (const bad of [
      "http://contacts.icloud.com/",
      "https://contacts.icloud.com.evil.invalid/",
      "https://p123-contacts.icloud.com:444/",
      "https://u:p@contacts.icloud.com/",
    ])
      expect(() => appleURL(bad)).toThrow();
  });
  it("sends ETag conditional mutations and surfaces conflicts", async () => {
    const { dav, http } = fixture([new Response("", { status: 412 })]);
    await expect(
      dav.save(book + "a.vcf", newCard("Alice"), '"old"'),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const calls = http.mock.calls as unknown as [string, RequestInit][];
    expect(calls.at(-1)?.[1].headers).toMatchObject({ "If-Match": '"old"' });
  });
  it("creates with If-None-Match and never writes missing ETag update", async () => {
    const { dav, http } = fixture([
      new Response(null, { status: 201, headers: { ETag: '"new"' } }),
    ]);
    expect(await dav.save(undefined, newCard("Alice"))).toMatchObject({
      saved: true,
      etag: '"new"',
    });
    const calls = http.mock.calls as unknown as [string, RequestInit][];
    expect(calls.at(-1)?.[1].headers).toMatchObject({ "If-None-Match": "*" });
    await expect(
      dav.save(book + "a.vcf", newCard("Bob")),
    ).rejects.toMatchObject({ code: "ETAG_REQUIRED" });
  });
  it("detects omitted multiget contacts rather than silently dropping them", async () => {
    const { dav } = fixture([new Response(multi(""), { status: 207 })]);
    await expect(dav.readMany([book + "a.vcf"])).rejects.toMatchObject({
      code: "INCOMPLETE",
    });
  });
  it("rejects XML entities and bounds remote bodies", async () => {
    expect(() =>
      multistatus(
        '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><multistatus/>',
      ),
    ).toThrow();
    await expect(boundedText(new Response("12345"), 4)).rejects.toThrow(
      "size limit",
    );
  });
  it("surfaces auth errors without exposing username or password", async () => {
    const { dav } = fixture([
      new Response("password not-a-real-password", { status: 401 }),
    ]);
    await expect(dav.read(book + "a.vcf")).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "CardDAV request failed (401)",
    });
  });
});

it("decodes numeric XML line endings once without corrupting literal entities", () => {
  const card =
    "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:test\r\nFN:Literal &amp;#13;\r\nEND:VCARD\r\n";
  const rows = multistatus(
    multi(
      item(
        "/test.vcf",
        `<d:getetag>"v1"</d:getetag><c:address-data>${card.replace(/\r/g, "&#13;")}</c:address-data>`,
      ),
    ),
  );
  expect(rows[0].props["address-data"]).toBe(card.replace("&amp;", "&"));
});
