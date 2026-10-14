import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
export interface CalendarEnv extends Omit<Env, "PUBLIC_ORIGIN"> {
  PUBLIC_ORIGIN: string;
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
  OWNER_PASSWORD: string;
  OAUTH_PROVIDER: OAuthHelpers;
}
