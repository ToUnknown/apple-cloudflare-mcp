import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
export type AppEnv = Cloudflare.Env & {
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
  OWNER_PASSWORD: string;
  EVENTS_ENCRYPTION_KEY?: string;
  MAIL_FROM?: string;
  MAIL_IDENTITIES?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
};
