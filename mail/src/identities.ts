import type { Address, Email } from "postal-mime";
import { email, PublicError } from "./schema";

export interface IdentityConfig {
  ICLOUD_USERNAME: string;
  MAIL_FROM?: string;
  MAIL_IDENTITIES?: string;
}

function validIdentity(value: string): string {
  const result = email.safeParse(value.trim());
  if (!result.success) {
    throw new PublicError(
      "Sender identities must be plain email addresses without display names or header line breaks.",
    );
  }
  return result.data;
}

export function mailIdentities(env: IdentityConfig) {
  const preferred = validIdentity(env.MAIL_FROM || env.ICLOUD_USERNAME);
  if (env.MAIL_IDENTITIES !== undefined && env.MAIL_IDENTITIES.length > 16384) {
    throw new PublicError(
      "MAIL_IDENTITIES is too long; configure at most 50 addresses.",
    );
  }
  const configured =
    env.MAIL_IDENTITIES === undefined
      ? [env.ICLOUD_USERNAME, ...(env.MAIL_FROM ? [env.MAIL_FROM] : [])]
      : env.MAIL_IDENTITIES.split(",");
  if (!configured.length || configured.length > 50) {
    throw new PublicError(
      "Configure between 1 and 50 MAIL_IDENTITIES addresses.",
    );
  }
  const allowed = [
    ...new Map(
      configured.map((value) => {
        const address = validIdentity(value);
        return [address.toLowerCase(), address] as const;
      }),
    ).values(),
  ];
  const actualPreferred = allowed.find(
    (value) => value.toLowerCase() === preferred.toLowerCase(),
  );
  if (!actualPreferred)
    throw new PublicError(
      "MAIL_FROM (or the default ICLOUD_USERNAME) must be listed in MAIL_IDENTITIES.",
    );
  return { preferred: actualPreferred, allowed };
}

export function addresses(items: Address[] = []): string[] {
  return items.flatMap((item) =>
    "group" in item
      ? addresses(item.group)
      : item.address
        ? [item.address]
        : [],
  );
}

export function selectSender(
  env: IdentityConfig,
  explicit?: string,
  receiving?: Pick<Email, "to" | "cc">,
): string {
  const identities = mailIdentities(env);
  const match = (value: string) =>
    identities.allowed.find(
      (address) => address.toLowerCase() === value.toLowerCase(),
    );
  if (explicit !== undefined) {
    const selected = match(validIdentity(explicit));
    if (!selected)
      throw new PublicError(
        "Sender is not allowed. Use an address returned by mail_identities.",
      );
    return selected;
  }
  // Only receiving To/Cc fields can select a reply identity. Incoming From/Reply-To/Sender never can.
  for (const value of [
    ...addresses(receiving?.to),
    ...addresses(receiving?.cc),
  ]) {
    const parsed = email.safeParse(value);
    if (parsed.success) {
      const selected = match(parsed.data);
      if (selected) return selected;
    }
  }
  return identities.preferred;
}
