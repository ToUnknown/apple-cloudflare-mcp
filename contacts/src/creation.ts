export interface CreationRecord {
  fingerprint: string;
  operationId: string;
  status: "pending" | "created" | "uncertain";
  startedAt: string;
  id?: string;
  etag?: string | null;
}
export interface CreationStore {
  reserve(record: CreationRecord): Promise<CreationRecord | null>;
  complete(record: CreationRecord): Promise<void>;
  receipt(): Promise<CreationRecord | null>;
}
export class OperationError extends Error {
  constructor(
    public code: string,
    message: string,
    public nextAction: string,
  ) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function publicReceipt(record: CreationRecord | null) {
  if (!record)
    return {
      status: "not_found",
      nextAction:
        "No reservation found. Retry the original request with the same operationId.",
    };
  const { fingerprint: _, ...receipt } = record;
  return {
    ...receipt,
    nextAction:
      record.status === "created"
        ? "Already created. Read the returned ID for current data; do not create again."
        : "Creation may have completed. Inspect records before considering a new operationId; this ID will not create again.",
  };
}
export async function createOnce<
  T extends { id: string; etag?: string | null },
>(
  store: CreationStore | undefined,
  operationId: string | undefined,
  input: unknown,
  action: () => Promise<T>,
) {
  if (!operationId)
    throw new OperationError(
      "OPERATION_ID_REQUIRED",
      "Creation requires a UUID operationId.",
      "Generate a UUID once for this intended creation and reuse it unchanged on retries.",
    );
  if (!store)
    throw new OperationError(
      "NOT_CONFIGURED",
      "Creation receipt storage is unavailable.",
      "Configure the CREATION_RECEIPTS Durable Object binding before creating records.",
    );
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(input)),
  );
  const fingerprint = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const initial: CreationRecord = {
    fingerprint,
    operationId,
    status: "pending",
    startedAt: new Date().toISOString(),
  };
  const previous = await store.reserve(initial);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new OperationError(
        "OPERATION_CONFLICT",
        "operationId was used with different input.",
        "Reuse the original input, or use a new UUID only for a separate intended creation.",
      );
    if (previous.status !== "created")
      throw new OperationError(
        "WRITE_UNCERTAIN",
        "Creation was started but not confirmed. No retry was performed.",
        publicReceipt(previous).nextAction,
      );
    return { ...publicReceipt(previous), replayed: true };
  }
  try {
    const result = await action();
    await store.complete({
      ...initial,
      status: "created",
      id: result.id,
      etag: result.etag,
    });
    return {
      ...result,
      operationId,
      status: "created" as const,
      replayed: false,
    };
  } catch {
    await store.complete({ ...initial, status: "uncertain" });
    throw new OperationError(
      "WRITE_UNCERTAIN",
      "Creation was not confirmed; it may have completed. This operationId will never create again.",
      "Search for the intended record before any new creation; check creation_receipt with this operationId.",
    );
  }
}
