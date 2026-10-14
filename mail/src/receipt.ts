export interface Receipt {
  fingerprint: string;
  operationId: string;
  messageId: string;
  status: "pending" | "accepted" | "uncertain";
  startedAt: string;
  from?: string;
  accepted?: string[];
  rejected?: string[];
  sentCopy?: "saved" | "failed";
  warning?: string;
}
export interface ReceiptStore {
  reserve(receipt: Receipt): Promise<Receipt | null>;
  save(receipt: Receipt): Promise<void>;
}
export async function runSend(
  store: ReceiptStore,
  initial: Receipt,
  action: () => Promise<
    Pick<Receipt, "from" | "accepted" | "rejected" | "sentCopy" | "warning">
  >,
): Promise<Receipt | { error: string }> {
  const existing = await store.reserve(initial);
  if (existing) {
    if (existing.fingerprint !== initial.fingerprint)
      return {
        error:
          "operationId was already used for different content. No mail sent.",
      };
    return existing.status === "pending"
      ? {
          ...existing,
          warning:
            "Send started; outcome may be unknown. Do not send again blindly. Inspect mailbox/recipient state.",
        }
      : existing;
  }
  try {
    const result = await action();
    const receipt: Receipt = { ...initial, ...result, status: "accepted" };
    await store.save(receipt);
    return receipt;
  } catch {
    const receipt: Receipt = {
      ...initial,
      status: "uncertain",
      warning:
        "Submission was not confirmed. It may have been accepted. This operationId will never send again; inspect Sent/recipient state before considering a new send.",
    };
    await store.save(receipt);
    return receipt;
  }
}
