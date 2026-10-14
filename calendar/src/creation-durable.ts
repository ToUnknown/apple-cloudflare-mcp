import { DurableObject } from "cloudflare:workers";
import type { CreationRecord } from "./creation";
// One strongly consistent receipt per operation; no event/contact content or credentials stored.
export class CreationReceipt extends DurableObject {
  async reserve(record: CreationRecord): Promise<CreationRecord | null> {
    return this.ctx.storage.transaction(async (txn) => {
      const old = await txn.get<CreationRecord>("receipt");
      if (old) return old;
      await txn.put("receipt", record);
      return null;
    });
  }
  async complete(record: CreationRecord): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const old = await txn.get<CreationRecord>("receipt");
      if (
        !old ||
        old.fingerprint !== record.fingerprint ||
        old.status !== "pending"
      )
        return;
      await txn.put("receipt", record);
    });
  }
  async receipt(): Promise<CreationRecord | null> {
    return (await this.ctx.storage.get<CreationRecord>("receipt")) ?? null;
  }
}
