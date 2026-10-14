import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseCard, serialize, value, isGroup } from "./vcard";
export class DavError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
export const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function appleURL(
  raw: string,
  base = "https://contacts.icloud.com/",
): URL {
  const u = new URL(raw, base);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    !/^(?:contacts\.icloud\.com|p\d{1,3}-contacts\.icloud\.com)$/.test(
      u.hostname,
    )
  )
    throw new DavError("UNSAFE_URL", "Untrusted CardDAV URL");
  try {
    if (
      u.pathname.split("/").some((part) => {
        const decoded = decodeURIComponent(part);
        return (
          decoded.includes("/") ||
          decoded.includes("\\") ||
          decoded === "." ||
          decoded === ".." ||
          /[\r\n\0]/.test(decoded)
        );
      })
    )
      throw new Error();
  } catch {
    throw new DavError("UNSAFE_URL", "Unsafe CardDAV path");
  }
  return u;
}
export async function boundedText(
  response: Response,
  max = 8 * 1024 * 1024,
): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > max)
    throw new DavError("TOO_LARGE", "Response exceeds size limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max)
        throw new DavError("TOO_LARGE", "Response exceeds size limit");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
type Node = Record<string, unknown>;
const array = (v: unknown): unknown[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const object = (v: unknown): Node =>
  v && typeof v === "object" ? (v as Node) : {};
const text = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number"
      ? String(v)
      : String(object(v)["#text"] ?? "");
export interface DavRecord {
  id: string;
  etag: string;
  vcard: string;
  uid: string;
  name: string;
  group: boolean;
}
export interface Book {
  id: string;
  name: string;
}
interface DavItem {
  href: string;
  props: Node;
  status?: number;
}
export function multistatus(body: string): DavItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true)
    throw new DavError("INVALID_XML", "Invalid DAV XML response");
  const parsed = object(
    new XMLParser({
      removeNSPrefix: true,
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: false,
      processEntities: true,
    }).parse(body),
  );
  const root = object(parsed.multistatus);
  if (!("multistatus" in parsed))
    throw new DavError("INVALID_XML", "Expected DAV multistatus");
  return array(root.response).map((raw) => {
    const r = object(raw);
    const href = text(r.href);
    if (!href) throw new DavError("INVALID_XML", "DAV response missing href");
    let props: Node = {};
    let failure: number | undefined;
    for (const block of array(r.propstat)) {
      const p = object(block);
      const status = Number(text(p.status).match(/\s(\d{3})(?:\s|$)/)?.[1]);
      if (status === 200) props = { ...props, ...object(p.prop) };
      else if (status && status !== 404) failure = status;
    }
    const status = Number(text(r.status).match(/\s(\d{3})(?:\s|$)/)?.[1]);
    return { href, props, status: status || failure };
  });
}
const propfind = (props: string) =>
  `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop>${props}</d:prop></d:propfind>`;
export class CardDAV {
  private books?: Book[];
  constructor(
    private username: string,
    private password: string,
    private http: typeof fetch = fetch,
  ) {}
  async request(
    raw: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<{ response: Response; body: string; url: string }> {
    let url = appleURL(raw);
    const signal = AbortSignal.timeout(20_000);
    for (let hop = 0; hop < 5; hop++) {
      let response: Response;
      try {
        response = await this.http(url.href, {
          method,
          redirect: "manual",
          signal,
          headers: {
            Authorization:
              "Basic " +
              btoa(
                unescape(
                  encodeURIComponent(this.username + ":" + this.password),
                ),
              ),
            "Content-Type":
              method === "PUT"
                ? "text/vcard; charset=utf-8"
                : "application/xml; charset=utf-8",
            ...headers,
          },
          body,
        });
      } catch {
        throw new DavError("NETWORK", "CardDAV request failed or timed out");
      }
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new DavError("REDIRECT", "Missing CardDAV redirect");
        url = appleURL(location, url.href);
        continue;
      }
      const payload = await boundedText(response);
      if (!response.ok)
        throw new DavError(
          response.status === 412
            ? "CONFLICT"
            : response.status === 404
              ? "NOT_FOUND"
              : response.status === 401 || response.status === 403
                ? "AUTH_FAILED"
                : "DAV_FAILED",
          response.status === 412
            ? "Record changed; read current ETag before retrying"
            : `CardDAV request failed (${response.status})`,
          response.status,
        );
      return { response, body: payload, url: url.href };
    }
    throw new DavError("REDIRECT", "Too many CardDAV redirects");
  }
  async discover(): Promise<Book[]> {
    if (this.books) return this.books;
    const first = await this.request(
      "https://contacts.icloud.com/",
      "PROPFIND",
      propfind("<d:current-user-principal/>"),
      { Depth: "0" },
    );
    const principal = multistatus(first.body)
      .map((i) => text(object(i.props["current-user-principal"]).href))
      .find(Boolean);
    if (!principal)
      throw new DavError("DISCOVERY", "Apple principal not found");
    const second = await this.request(
      appleURL(principal, first.url).href,
      "PROPFIND",
      propfind("<c:addressbook-home-set/>"),
      { Depth: "0" },
    );
    const homes = multistatus(second.body).flatMap((i) =>
      array(object(i.props["addressbook-home-set"]).href).map(text),
    );
    if (!homes.length)
      throw new DavError("DISCOVERY", "Apple addressbook home not found");
    const books: Book[] = [];
    for (const home of homes) {
      const r = await this.request(
        appleURL(home, second.url).href,
        "PROPFIND",
        propfind("<d:resourcetype/><d:displayname/>"),
        { Depth: "1" },
      );
      for (const i of multistatus(r.body)) {
        if (i.status)
          throw new DavError("DAV_FAILED", "Failed addressbook discovery item");
        if ("addressbook" in object(i.props.resourcetype)) {
          const id = appleURL(i.href, r.url).href;
          if (!id.endsWith("/"))
            throw new DavError("DISCOVERY", "Addressbook URL must end with /");
          books.push({ id, name: text(i.props.displayname) || "Contacts" });
        }
      }
    }
    if (!books.length)
      throw new DavError("DISCOVERY", "No CardDAV addressbooks found");
    this.books = books;
    return books;
  }
  async book(id?: string): Promise<Book> {
    const books = await this.discover();
    if (id) {
      const found = books.find((b) => b.id === id);
      if (!found) throw new DavError("INVALID_ID", "Unknown addressbook");
      return found;
    }
    if (books.length !== 1)
      throw new DavError(
        "AMBIGUOUS",
        "Choose addressbookId from list_addressbooks",
      );
    return books[0];
  }
  async recordID(id: string): Promise<string> {
    const u = appleURL(id);
    const books = await this.discover();
    if (
      !books.some(
        (b) =>
          u.href.startsWith(b.id) &&
          u.href.slice(b.id.length) &&
          !u.href.slice(b.id.length).includes("/"),
      )
    )
      throw new DavError(
        "INVALID_ID",
        "Contact ID is outside discovered addressbooks",
      );
    return u.href;
  }
  async inventory(bookId?: string): Promise<{ id: string; etag: string }[]> {
    const book = await this.book(bookId);
    const r = await this.request(
      book.id,
      "PROPFIND",
      propfind("<d:getetag/><d:resourcetype/>"),
      { Depth: "1" },
    );
    const result: { id: string; etag: string }[] = [];
    for (const i of multistatus(r.body)) {
      if (i.status)
        throw new DavError("DAV_FAILED", "Failed DAV inventory item");
      const id = appleURL(i.href, r.url).href;
      if (id === book.id) continue;
      if (!id.startsWith(book.id) || id.slice(book.id.length).includes("/"))
        throw new DavError("INVALID_ID", "Unexpected DAV inventory URL");
      if ("collection" in object(i.props.resourcetype)) continue;
      const etag = text(i.props.getetag);
      if (!etag)
        throw new DavError("MISSING_ETAG", "Contact inventory item lacks ETag");
      result.push({ id, etag });
    }
    if (result.length > 5000)
      throw new DavError(
        "TOO_MANY",
        "Addressbook exceeds 5000-record safety limit",
      );
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  private record(id: string, etag: string, vcard: string): DavRecord {
    if (!etag) throw new DavError("MISSING_ETAG", "Apple did not return ETag");
    const lines = parseCard(vcard);
    return {
      id,
      etag,
      vcard,
      uid: value(lines, "UID"),
      name: value(lines, "FN"),
      group: isGroup(lines),
    };
  }
  async read(id: string): Promise<DavRecord> {
    id = await this.recordID(id);
    const r = await this.request(id, "GET");
    if (r.url !== id)
      throw new DavError(
        "INVALID_ID",
        "Record moved; rediscover the addressbook",
      );
    return this.record(id, r.response.headers.get("etag") ?? "", r.body);
  }
  async readMany(ids: string[], bookId?: string): Promise<DavRecord[]> {
    if (!ids.length) return [];
    const book = await this.book(bookId);
    if (
      ids.some(
        (id) =>
          !id.startsWith(book.id) || id.slice(book.id.length).includes("/"),
      )
    )
      throw new DavError("INVALID_ID", "Record outside selected addressbook");
    const r = await this.request(
      book.id,
      "REPORT",
      `<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop>${ids.map((id) => `<d:href>${xml(new URL(id).pathname)}</d:href>`).join("")}</c:addressbook-multiget>`,
      { Depth: "1" },
    );
    const byId = new Map<string, DavRecord>();
    for (const i of multistatus(r.body)) {
      if (i.status)
        throw new DavError(
          "DAV_FAILED",
          "A requested contact could not be read; retry after refreshing inventory",
        );
      const id = appleURL(i.href, r.url).href;
      if (!ids.includes(id) || byId.has(id))
        throw new DavError(
          "INVALID_XML",
          "Unexpected or duplicate DAV response",
        );
      byId.set(
        id,
        this.record(id, text(i.props.getetag), text(i.props["address-data"])),
      );
    }
    if (byId.size !== ids.length)
      throw new DavError(
        "INCOMPLETE",
        "Apple omitted requested records; retry",
      );
    return ids.map((id) => byId.get(id)!);
  }
  async save(
    id: string | undefined,
    lines: string[],
    etag?: string,
    bookId?: string,
  ): Promise<{ id: string; etag: string | null; saved: true }> {
    const vcard = serialize(lines);
    parseCard(vcard);
    if (id) {
      id = await this.recordID(id);
      if (!etag || etag === "*" || /^W\//.test(etag) || /[\r\n]/.test(etag))
        throw new DavError(
          "ETAG_REQUIRED",
          "Existing record requires a strong exact ETag",
        );
    } else {
      id = (await this.book(bookId)).id + crypto.randomUUID() + ".vcf";
    }
    const r = await this.request(
      id,
      "PUT",
      vcard,
      id && etag ? { "If-Match": etag } : { "If-None-Match": "*" },
    );
    return { id, etag: r.response.headers.get("etag"), saved: true };
  }
  async delete(
    id: string,
    etag: string,
  ): Promise<{ deleted: true; id: string }> {
    id = await this.recordID(id);
    if (!etag || etag === "*" || /^W\//.test(etag) || /[\r\n]/.test(etag))
      throw new DavError(
        "ETAG_REQUIRED",
        "Delete requires a strong exact ETag",
      );
    await this.request(id, "DELETE", undefined, { "If-Match": etag });
    return { deleted: true, id };
  }
}
