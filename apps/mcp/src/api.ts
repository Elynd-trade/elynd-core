// HTTP client for the Elynd REST API (routes: ./api-routes.ts).
// No private keys or signatures here: only the user's Bearer API key (ek_...).

import { API_ROUTES } from "./api-routes";
import type { Config } from "./config";
import type { ApiError } from "./spec";

export type RouteKey = keyof typeof API_ROUTES;

/** The API answered with an error (HTTP status + ApiError). */
export class ElyndApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ElyndApiError";
  }
}

/** The API is unreachable (network, timeout, non-JSON response). */
export class ElyndNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElyndNetworkError";
  }
}

/** MCP configuration error (e.g. no API key). */
export class ElyndConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElyndConfigError";
  }
}

export interface RequestOptions {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

function isApiError(x: unknown): x is ApiError {
  if (!x || typeof x !== "object") return false;
  const e = (x as { error?: unknown }).error;
  return !!e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string";
}

export class ApiClient {
  constructor(private readonly cfg: Config) {}

  get hasApiKey(): boolean {
    return !!this.cfg.apiKey;
  }

  buildUrl(key: RouteKey, opts: RequestOptions = {}): string {
    let path: string = API_ROUTES[key].path;
    path = path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
      const v = opts.params?.[name];
      if (v === undefined) throw new Error(`missing path param ${name} for ${key}`);
      return encodeURIComponent(String(v));
    });
    const url = new URL(this.cfg.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async call<T>(key: RouteKey, opts: RequestOptions = {}): Promise<T> {
    const route = API_ROUTES[key];
    const needsAuth = route.auth !== "none";
    if (needsAuth && !this.cfg.apiKey) {
      throw new ElyndConfigError(
        "ELYND_API_KEY is not set (ELYSIUM_API_KEY is also accepted). This action requires an API key: the user must create one on the website " +
          `(${this.cfg.webUrl}/account, API keys; it starts with "ek_") and add it to the MCP server env, then restart the MCP server.`,
      );
    }

    const url = this.buildUrl(key, opts);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: route.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      const reason =
        e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? `request timed out after ${this.cfg.timeoutMs} ms` : describeCause(e);
      throw new ElyndNetworkError(
        `Could not reach the Elynd API at ${this.cfg.apiUrl} (${route.method} ${route.path}): ${reason}. ` +
          "The backend may be down or ELYND_API_URL may be wrong. Try again later or check the server configuration.",
      );
    }

    const text = await res.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (!res.ok) {
      if (isApiError(data)) {
        throw new ElyndApiError(res.status, data.error.code || "error", data.error.message);
      }
      throw new ElyndApiError(res.status, `http_${res.status}`, text.slice(0, 300) || res.statusText || "request failed");
    }
    if (data === undefined && text) {
      throw new ElyndNetworkError(
        `The Elynd API at ${this.cfg.apiUrl} returned a non-JSON response for ${route.method} ${route.path}. ` +
          "ELYND_API_URL may point to the wrong service.",
      );
    }
    return data as T;
  }
}

function describeCause(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      return code ? `${code}: ${cause.message}` : cause.message;
    }
    return e.message;
  }
  return String(e);
}

/** Human-readable error text for a tool result. */
export function describeError(e: unknown): string {
  if (e instanceof ElyndApiError) {
    let hint = "";
    if (e.status === 401) {
      hint = " The API key is missing, invalid or revoked. Ask the user to create a new key on the website Account page and update ELYND_API_KEY.";
    } else if (e.status === 403) {
      hint = " The API key's owner is not allowed to do this (e.g. not the owner of this agent).";
    } else if (e.status === 404) {
      hint = " The requested object was not found (check the id).";
    } else if (e.status >= 500) {
      hint = " The backend had an internal problem; try again later.";
    }
    return `Elynd API error ${e.status} (${e.code}): ${e.message}.${hint}`;
  }
  if (e instanceof ElyndNetworkError || e instanceof ElyndConfigError) return e.message;
  if (e instanceof Error) return `Unexpected error: ${e.message}`;
  return `Unexpected error: ${String(e)}`;
}
