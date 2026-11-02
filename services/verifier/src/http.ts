import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

export interface HttpResponse {
  status: number;
  body: Buffer;
  latencyMs: number;
}

/** Transport failures; kept distinct from "got a response that failed the checks". */
export class TransportError extends Error {
  constructor(
    readonly kind: "TIMEOUT" | "NETWORK" | "BODY_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface RequestOptions {
  method: string;
  url: URL;
  /** The vetted address from resolvePinned; the socket connects only here. */
  pinned: { address: string; family: 4 | 6 };
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

/**
 * One request, no redirects (Node's http client never follows them), hard limits on
 * total time and response size. TLS still validates the certificate against the
 * hostname, while the TCP connection goes to the pinned address.
 */
export function sendRequest(opts: RequestOptions): Promise<HttpResponse> {
  const lookup: LookupFunction = (_host, options, cb) => {
    if (options?.all) {
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [opts.pinned]);
    } else {
      cb(null, opts.pinned.address, opts.pinned.family);
    }
  };
  const send = opts.url.protocol === "https:" ? httpsRequest : httpRequest;
  const started = performance.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };

    const req = send(
      opts.url,
      {
        method: opts.method,
        lookup,
        headers: {
          accept: "application/json",
          "user-agent": "settle-verifier/0.1",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        agent: false,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxResponseBytes) {
            req.destroy();
            finish(() => reject(new TransportError("BODY_TOO_LARGE", `response exceeded ${opts.maxResponseBytes} bytes`)));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), latencyMs: Math.round(performance.now() - started) }),
          ),
        );
        res.on("error", (e) => finish(() => reject(new TransportError("NETWORK", e.message))));
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new TransportError("TIMEOUT", `no complete response within ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);

    req.on("error", (e) => finish(() => reject(new TransportError("NETWORK", e.message))));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
