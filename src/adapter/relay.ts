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
  json?: unknown;
  text?: string;
  base64?: string;
  error?: string;
}

export interface HelloResponse {
  origin: string;
  href: string;
  hasSession: boolean;
}
