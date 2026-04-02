/**
 * Lightweight HTTP client for talking to the local Deus backend.
 * Centralizes error handling and JSON parsing.
 */

import { request } from "node:http";

/** GET request to localhost backend, returns parsed JSON or null on error */
export function httpGet<T>(port: number, path: string, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const req = request(
      { hostname: "localhost", port, path, method: "GET", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/** POST request to localhost backend, returns parsed JSON or throws on error */
export function httpPost<T>(port: number, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = request(
      {
        hostname: "localhost",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`${path} returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`Invalid JSON from ${path}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout: ${path}`));
    });
    req.end(payload);
  });
}
