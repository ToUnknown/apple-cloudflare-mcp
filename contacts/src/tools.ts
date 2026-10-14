import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CardDAV, DavError } from "./carddav";
import {
  parseCard,
  patchCard,
  clearProperties,
  newCard,
  membership,
  serialize,
  splitCards,
  value,
  values,
  escapeText,
  isGroup,
} from "./vcard";
const id = z.string().url().max(2048);
const etag = z.string().min(1).max(256);
const book = { addressbookId: id.optional() };
const props = z
  .array(
    z.object({
      name: z.string().max(80),
      value: z.string().max(500_000),
      parameters: z.string().max(1024).optional(),
    }),
  )
  .max(200);
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
export function createServer(dav: CardDAV): McpServer {
  const server = new McpServer({ name: "icloud-contacts", version: "0.1.0" });
  const result = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      return result(await fn());
    } catch (e) {
      return {
        isError: true,
        ...result({
          error: e instanceof DavError ? e.code : "INVALID_CONTACT",
          message:
            e instanceof DavError || e instanceof Error
              ? e.message
              : "Contacts operation failed",
        }),
      };
    }
  };
  server.registerTool(
    "list_addressbooks",
    {
      description:
        "List discovered iCloud CardDAV addressbooks. Use an addressbookId when more than one exists.",
      inputSchema: {},
      annotations: read,
    },
    () => run(() => dav.discover())(),
  );
  const page = {
    ...book,
    query: z.string().max(200).default(""),
    offset: z.number().int().min(0).max(5000).default(0),
    limit: z.number().int().min(1).max(50).default(25),
  };
  async function search(
    args: {
      addressbookId?: string;
      query: string;
      offset: number;
      limit: number;
    },
    groups: boolean,
  ) {
    const inventory = await dav.inventory(args.addressbookId);
    const found = [];
    let scanned = args.offset;
    let bytes = 0;
    const q = args.query.toLocaleLowerCase();
    while (scanned < inventory.length && found.length < args.limit) {
      const batch = inventory.slice(
        scanned,
        Math.min(
          inventory.length,
          scanned + Math.min(25, args.limit - found.length),
        ),
      );
      const cards = await dav.readMany(
        batch.map((i) => i.id),
        args.addressbookId,
      );
      for (const card of cards) {
        scanned++;
        if (
          card.group === groups &&
          (!q || card.vcard.toLocaleLowerCase().includes(q))
        ) {
          bytes += new TextEncoder().encode(card.vcard).length;
          if (bytes > 8 * 1024 * 1024)
            throw new Error("Page exceeds 8 MiB; retry with a smaller limit");
          found.push(card);
        }
      }
    }
    return {
      records: found,
      nextOffset: scanned < inventory.length ? scanned : null,
      inventoryCount: inventory.length,
      scannedThrough: scanned,
      pagingNote:
        "Offsets apply to sorted inventory. Restart at 0 after adding/deleting records.",
    };
  }
  server.registerTool(
    "search_contacts",
    {
      description:
        "Search all vCard properties, including emails, phones, notes and phonetics. Returns raw vCards, stable URL IDs and ETags. Page with nextOffset; inventories over 5000 fail explicitly.",
      inputSchema: page,
      annotations: read,
    },
    (args) => run(() => search(args, false))(),
  );
  server.registerTool(
    "list_groups",
    {
      description:
        "List Apple contact lists/groups, which are separate group vCards with member UID references. Page with nextOffset.",
      inputSchema: page,
      annotations: read,
    },
    (args) => run(() => search(args, true))(),
  );
  server.registerTool(
    "read_contact",
    {
      description:
        "Read any contact or group, including its original vCard, UID and ETag. Original vCards preserve custom fields and embedded photos.",
      inputSchema: { id },
      annotations: read,
    },
    (args) => run(() => dav.read(args.id))(),
  );
  server.registerTool(
    "save_contact",
    {
      description:
        "Create or edit a contact. Existing records require id and ETag from read_contact. Replaces only explicitly named properties; unknown fields remain. Property values use vCard escaping; structured N/ADR/ORG values use semicolons. Use raw vCard import for full-fidelity creation. clear removes exact property names. Grouped properties use item1.TEL, item1.X-ABLabel, etc.",
      inputSchema: {
        ...book,
        id: id.optional(),
        etag: etag.optional(),
        formattedName: z.string().min(1).max(500).optional(),
        properties: props.default([]),
        clear: z.array(z.string().max(80)).max(100).default([]),
      },
      annotations: destructive,
    },
    (args) =>
      run(async () => {
        let lines: string[];
        if (args.id) {
          const record = await dav.read(args.id);
          if (record.group) throw new Error("Use save_group for group records");
          if (args.etag !== record.etag)
            throw new DavError(
              "CONFLICT",
              "ETag differs; read current contact",
            );
          lines = parseCard(record.vcard);
        } else {
          if (!args.formattedName)
            throw new Error("New contact needs formattedName");
          if (args.etag) throw new Error("ETag requires an existing ID");
          lines = newCard(args.formattedName);
        }
        lines = clearProperties(lines, args.clear);
        lines = patchCard(lines, args.properties);
        if (args.formattedName)
          lines = patchCard(lines, [
            { name: "FN", value: escapeText(args.formattedName) },
          ]);
        return dav.save(args.id, lines, args.etag, args.addressbookId);
      })(),
  );
  server.registerTool(
    "delete_contact",
    {
      description:
        "Permanently delete one contact using its current ETag. Remove its group memberships first if required. Group records use delete_group.",
      inputSchema: { id, etag },
      annotations: destructive,
    },
    (args) =>
      run(async () => {
        const r = await dav.read(args.id);
        if (r.group) throw new Error("Use delete_group");
        if (r.etag !== args.etag)
          throw new DavError("CONFLICT", "ETag differs; read current contact");
        return dav.delete(args.id, args.etag);
      })(),
  );
  server.registerTool(
    "save_group",
    {
      description:
        "Create an Apple contact list/group, or rename an existing group while preserving members and custom fields.",
      inputSchema: {
        ...book,
        id: id.optional(),
        etag: etag.optional(),
        name: z.string().min(1).max(500),
      },
      annotations: destructive,
    },
    (args) =>
      run(async () => {
        let lines = newCard(args.name, true);
        if (args.id) {
          const r = await dav.read(args.id);
          if (!r.group) throw new Error("Record is not a group");
          if (r.etag !== args.etag)
            throw new DavError("CONFLICT", "ETag differs; read current group");
          lines = patchCard(parseCard(r.vcard), [
            { name: "FN", value: escapeText(args.name) },
          ]);
        } else if (args.etag) throw new Error("ETag requires existing ID");
        return dav.save(args.id, lines, args.etag, args.addressbookId);
      })(),
  );
  server.registerTool(
    "delete_group",
    {
      description:
        "Permanently delete a list/group using its ETag. Member contacts remain.",
      inputSchema: { id, etag },
      annotations: destructive,
    },
    (args) =>
      run(async () => {
        const r = await dav.read(args.id);
        if (!r.group) throw new Error("Record is not a group");
        if (r.etag !== args.etag)
          throw new DavError("CONFLICT", "ETag differs; read current group");
        return dav.delete(args.id, args.etag);
      })(),
  );
  server.registerTool(
    "read_group_members",
    {
      description:
        "Read a group member list. Returns UID references and matching contact IDs; unresolved references are reported explicitly.",
      inputSchema: { groupId: id },
      annotations: read,
    },
    (args) =>
      run(async () => {
        const group = await dav.read(args.groupId);
        if (!group.group) throw new Error("Record is not a group");
        const lines = parseCard(group.vcard);
        const members = [
          ...values(lines, "X-ADDRESSBOOKSERVER-MEMBER"),
          ...values(lines, "MEMBER"),
        ];
        const addressbookId = group.id.slice(0, group.id.lastIndexOf("/") + 1);
        const inventory = await dav.inventory(addressbookId);
        const records = new Map<string, { id: string; name: string }>();
        for (let i = 0; i < inventory.length; i += 25)
          for (const c of await dav.readMany(
            inventory.slice(i, i + 25).map((r) => r.id),
            addressbookId,
          ))
            if (!c.group)
              records.set(c.uid.toLowerCase().replace(/^urn:uuid:/, ""), {
                id: c.id,
                name: c.name,
              });
        return {
          groupId: group.id,
          etag: group.etag,
          members: members.map((reference) => ({
            reference,
            contact:
              records.get(reference.toLowerCase().replace(/^urn:uuid:/, "")) ??
              null,
          })),
        };
      })(),
  );
  server.registerTool(
    "change_group_members",
    {
      description:
        "Add/remove contacts to/from an Apple group, storing X-ADDRESSBOOKSERVER-MEMBER:urn:uuid references. Requires group ETag and contact IDs in the same addressbook.",
      inputSchema: {
        groupId: id,
        etag,
        contactIds: z.array(id).min(1).max(50),
        action: z.enum(["add", "remove"]),
      },
      annotations: destructive,
    },
    (args) =>
      run(async () => {
        const r = await dav.read(args.groupId);
        if (r.etag !== args.etag)
          throw new DavError("CONFLICT", "ETag differs; read current group");
        if (!r.group) throw new Error("Record is not a group");
        let lines = parseCard(r.vcard);
        for (const contactId of args.contactIds) {
          if (
            new URL(contactId).pathname.slice(
              0,
              new URL(contactId).pathname.lastIndexOf("/"),
            ) !==
              new URL(r.id).pathname.slice(
                0,
                new URL(r.id).pathname.lastIndexOf("/"),
              ) ||
            new URL(contactId).origin !== new URL(r.id).origin
          )
            throw new Error("Members must be in the same addressbook");
          const c = await dav.read(contactId);
          if (c.group) throw new Error("Nested groups are not supported");
          lines = membership(lines, c.uid, args.action === "add");
        }
        return dav.save(r.id, lines, args.etag);
      })(),
  );
  server.registerTool(
    "export_vcards",
    {
      description:
        "Export exact original vCards for up to 100 selected IDs. Use search_contacts/list_groups pages to select IDs. Includes photos and unknown properties.",
      inputSchema: { ids: z.array(id).min(1).max(100) },
      annotations: read,
    },
    (args) =>
      run(async () => {
        const cards = [];
        let bytes = 0;
        for (const contactId of args.ids) {
          const record = await dav.read(contactId);
          bytes += new TextEncoder().encode(record.vcard).length;
          if (bytes > 8 * 1024 * 1024)
            throw new Error("Export exceeds 8 MiB; export fewer records");
          cards.push(record.vcard);
        }
        return { count: cards.length, vcard: cards.join("") };
      })(),
  );
  server.registerTool(
    "import_vcards",
    {
      description:
        "Import up to 100 validated vCards as new records; preserves every field. Existing UID collisions are rejected. Group cards are rejected because external member references may be invalid. Returns each success/failure; import is not atomic and retries must exclude successes.",
      inputSchema: {
        ...book,
        vcard: z
          .string()
          .min(1)
          .max(8 * 1024 * 1024),
      },
      annotations: write,
    },
    (args) =>
      run(async () => {
        const cards = splitCards(args.vcard);
        if (cards.some((c) => isGroup(parseCard(c))))
          throw new Error(
            "Import contacts only; create groups then add members",
          );
        const inventory = await dav.inventory(args.addressbookId);
        const uids = new Set<string>();
        for (let i = 0; i < inventory.length; i += 25)
          for (const c of await dav.readMany(
            inventory.slice(i, i + 25).map((r) => r.id),
            args.addressbookId,
          ))
            uids.add(c.uid);
        const records = [];
        for (let i = 0; i < cards.length; i++) {
          const lines = parseCard(cards[i]);
          const uid = value(lines, "UID");
          try {
            if (uids.has(uid))
              throw new Error("UID already exists; no overwrite performed");
            const saved = await dav.save(
              undefined,
              lines,
              undefined,
              args.addressbookId,
            );
            uids.add(uid);
            records.push({ index: i, uid, ...saved });
          } catch (e) {
            records.push({
              index: i,
              uid,
              error: e instanceof DavError ? e.code : "IMPORT_FAILED",
              message: e instanceof Error ? e.message : "Import failed",
            });
          }
        }
        return { records, atomic: false };
      })(),
  );
  return server;
}
