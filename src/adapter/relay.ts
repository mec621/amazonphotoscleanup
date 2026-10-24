// Message shapes shared by the content-script relay and the adapter. Types only.

export interface RelayRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: 'json' | 'base64';
}

export interface RelayResponse {
  ok: boolean;
  status: number;
  contentType?: string;
  /** Retry-After header, on 429/503. */
  retryAfter?: string;
  json?: unknown;
  text?: string;
  base64?: string;
  error?: string;
}

export interface HelloResponse {
  origin: string;
  href: string;
  hasSession: boolean;
  /** The last /drive/v1/search URL the Amazon Photos web app itself requested, if any. */
  webSearchUrl: string | null;
}
