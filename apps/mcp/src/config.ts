// MCP server configuration from environment variables.
// ELYND_* names are preferred; the ELYSIUM_* names used by earlier documentation are still accepted.

export interface Config {
  apiUrl: string;
  apiKey: string | undefined;
  webUrl: string;
  timeoutMs: number;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function pick(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`ELYND_${name}`]?.trim() || env[`ELYSIUM_${name}`]?.trim() || undefined;
}

/** Default API URL is a local backend; the hosted API URL is listed at https://elynd.trade/docs. */
export const DEFAULT_API_URL = "http://localhost:8787";
export const DEFAULT_WEB_URL = "https://elynd.trade";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeout = Number(pick(env, "TIMEOUT_MS"));
  return {
    apiUrl: trimSlash(pick(env, "API_URL") || DEFAULT_API_URL),
    apiKey: pick(env, "API_KEY"),
    webUrl: trimSlash(pick(env, "WEB_URL") || DEFAULT_WEB_URL),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}
