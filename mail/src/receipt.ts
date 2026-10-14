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
  errorCode?: string;
  errorCommand?: string;
  errorType?: string;
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
  } catch (error) {
    const detail =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    // Include only bounded protocol identifiers, never provider text, credentials, or message content.
    const code =
      typeof detail.code === "string" && /^[A-Z_0-9]{1,32}$/.test(detail.code)
        ? detail.code
        : undefined;
    const command =
      typeof detail.command === "string" &&
      /^(CONN|EHLO|HELO|STARTTLS|AUTH(?: [A-Z0-9-]+)?|MAIL FROM|RCPT TO|DATA|QUIT)$/.test(
        detail.command,
      )
        ? detail.command
        : undefined;
    const type =
      detail.name === "TypeError"
        ? "TypeError"
        : detail.name === "Error"
          ? "Error"
          : undefined;
    const receipt: Receipt = {
      ...initial,
      status: "uncertain",
      errorCode: code,
      errorCommand: command,
      errorType: type,
      warning:
        "Submission was not confirmed. It may have been accepted. This operationId will never send again; inspect Sent/recipient state before considering a new send.",
    };
    await store.save(receipt);
    return receipt;
  }
}
