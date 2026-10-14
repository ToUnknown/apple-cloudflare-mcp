import type { ImapFlow } from "imapflow";
import type { Arrival, Position } from "./events";
export async function scanInbox(
  client: ImapFlow,
  previous?: Position,
): Promise<{ position: Position; messages: Arrival[]; reset: boolean }> {
  return (await scanInboxBatch(client, [previous]))[0]!;
}
export async function scanInboxBatch(client: ImapFlow, positions: (Position | undefined)[]) {
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });
  try {
    if (!client.mailbox) throw new Error("INBOX unavailable");
    const current = {
      uidValidity: client.mailbox.uidValidity.toString(),
      nextUid: client.mailbox.uidNext,
    };
    if (!Number.isSafeInteger(current.nextUid) || current.nextUid < 1)
      throw new Error("Missing UIDNEXT");
    const valid = positions.filter((p): p is Position => !!p && p.uidValidity === current.uidValidity && p.nextUid <= current.nextUid);
    const previous = valid.sort((a, b) => a.nextUid - b.nextUid)[0];
    const project = (position: Position, messages: Arrival[]) => positions.map(p => {
      if (!p || p.uidValidity !== current.uidValidity || p.nextUid > current.nextUid)
        return {position: current, messages: [], reset: true};
      if (p.nextUid > position.nextUid) return {position: p, messages: [], reset: false};
      return {position, messages: messages.filter(m => m.uid >= p.nextUid), reset: false};
    });
    if (!previous || previous.nextUid === current.nextUid) return project(current, []);
    // Numeric range avoids IMAP n:* returning old mail when n exceeds the last UID.
    const end = Math.min(current.nextUid - 1, previous.nextUid + 9);
    const messages: Arrival[] = [];
    for await (const m of client.fetch(
      `${previous.nextUid}:${end}`,
      { uid: true, envelope: true, internalDate: true },
      { uid: true },
    )) {
      if (
        m.uid < previous.nextUid ||
        m.uid > end ||
        !(m.internalDate instanceof Date)
      )
        continue;
      if (!m.envelope) throw new Error("Incomplete envelope");
      const addresses = (items: { address?: string }[] | undefined) =>
        (items ?? []).map((a) => a.address ?? "").filter(Boolean);
      const from = addresses(m.envelope.from),
        to = addresses([...(m.envelope.to ?? []), ...(m.envelope.cc ?? [])]);
      // Never truncate filter inputs silently. Very large envelopes fail closed for this batch.
      if (
        from.length > 20 ||
        to.length > 20 ||
        [...from, ...to].some((a) => a.length > 254) ||
        (m.envelope.subject?.length ?? 0) > 1024
      )
        throw new Error("Envelope exceeds event bounds");
      messages.push({
        uid: m.uid,
        timestamp: m.internalDate.toISOString(),
        subject: m.envelope.subject ?? "",
        from,
        to,
        messageId: (m.envelope.messageId ?? "").slice(0, 998),
      });
    }
    return project({ uidValidity: current.uidValidity, nextUid: end + 1 }, messages);
  } finally {
    lock.release();
  }
}
