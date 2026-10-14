export interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
  nextAction: string;
}
export function actionableError(
  message: string,
  write: boolean,
  code?: string,
): AgentError {
  if (/conflict|ETag differs|stale|UIDVALIDITY/i.test(message))
    return {
      code: "CONFLICT",
      message,
      retryable: false,
      nextAction:
        "Read the current record, reconsider the change, then use its new version/ETag.",
    };
  if (
    code === "NOT_FOUND" ||
    /not found|HTTP 404|does not exist|no longer exists|missing message/i.test(
      message,
    )
  )
    return {
      code: "NOT_FOUND",
      message,
      retryable: false,
      nextAction: "Search again for the record. Do not reuse this missing ID.",
    };
  if (
    /too (?:large|many)|exceeds|size limit|narrow|limit exceeded/i.test(message)
  )
    return {
      code: "LIMIT_EXCEEDED",
      message,
      retryable: false,
      nextAction:
        "Narrow the date range, reduce the page size or request fewer records.",
    };
  if (/denied|unauthor|forbidden|credentials|authentication/i.test(message))
    return {
      code: "ACCESS_DENIED",
      message,
      retryable: false,
      nextAction:
        "Check the configured account, app-specific password and collection permissions.",
    };
  if (/timed out|failed|unavailable|uncertain|not confirmed/i.test(message))
    return {
      code: write ? "WRITE_UNCERTAIN" : "TEMPORARILY_UNAVAILABLE",
      message,
      retryable: !write,
      nextAction: write
        ? "Inspect the record or operation receipt before retrying; the write may have completed."
        : "Retry this read later. If it repeats, check account connectivity.",
    };
  return {
    code: code ?? "INVALID_ARGUMENT",
    message,
    retryable: false,
    nextAction:
      "Correct the input using the tool schema. Read the current record if editing.",
  };
}
