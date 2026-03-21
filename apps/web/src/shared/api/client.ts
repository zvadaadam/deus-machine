/**
 * Base API Client
 * Handles HTTP requests with proper error handling and type safety.
 *
 * Dual-transport: In relay mode (web-production), wraps HTTP requests as
 * http:request frames and tunnels them through the WebSocket connection.
 * In desktop/web-dev mode, uses normal HTTP fetch.
 *
 * Attaches Bearer token for remote (non-localhost) browser clients.
 */

import { getBaseURL } from "../config/api.config";
import { isRelayMode } from "../config/backend.config";
import { getStoredToken, needsRemoteAuth } from "@/features/auth";
import { isConnected, sendHttpRequest } from "@/platform/ws";
import type { HttpRequestFrame } from "@shared/types/http-bridge";
import type { ApiError } from "../types";

const REQUEST_TIMEOUT = 30_000;

class ApiClient {
  private timeout: number;

  constructor(timeout: number = REQUEST_TIMEOUT) {
    this.timeout = timeout;
  }

  /**
   * Generic GET request
   */
  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "GET" });
  }

  /**
   * Generic POST request
   */
  async post<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * Generic PUT request
   */
  async put<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * Generic PATCH request
   */
  async patch<T>(endpoint: string, data: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }

  /**
   * Generic DELETE request
   */
  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: "DELETE" });
  }

  /**
   * Core request method with timeout and error handling.
   *
   * In relay mode: wraps the request as an http:request frame, sends through
   * the WS tunnel, and awaits the http:response. This lets all 26+ HTTP
   * endpoints work through the cloud relay without any relay changes.
   *
   * In desktop/web-dev mode: normal HTTP fetch with Bearer token for remote clients.
   */
  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    // Relay mode: ALL HTTP goes through the WS bridge — never fall through to fetch.
    // If WS isn't connected yet, throw so React Query retries after connection.
    if (isRelayMode()) {
      if (!isConnected()) {
        throw {
          status: 0,
          message: "WebSocket not connected — waiting for relay connection",
        } as ApiError;
      }
      return this.requestViaWsBridge<T>(endpoint, options);
    }

    // Desktop/web-dev: normal HTTP fetch
    return this.requestViaFetch<T>(endpoint, options);
  }

  /**
   * Tunnel an HTTP request through the WebSocket connection (relay mode).
   * Wraps as http:request frame, sends through relay, awaits http:response.
   */
  private async requestViaWsBridge<T>(endpoint: string, options: RequestInit): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.headers) {
      const h = new Headers(options.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }

    const frame: HttpRequestFrame = {
      type: "http:request",
      requestId: crypto.randomUUID(),
      method: options.method || "GET",
      // Prefix with /api since endpoints don't include it (getBaseURL does)
      path: `/api${endpoint}`,
      headers,
      body: (options.body as string) ?? null,
    };

    try {
      const response = await sendHttpRequest(frame);

      if (response.status >= 400) {
        const error: ApiError = {
          status: response.status,
          message: `HTTP ${response.status}`,
        };

        try {
          if (response.body) {
            const errorData = JSON.parse(response.body);
            error.details = errorData;
            error.message = errorData.error || errorData.message || error.message;
          }
        } catch {
          // Response body is not JSON
        }

        throw error;
      }

      // Handle empty responses
      const contentType = response.headers?.["content-type"] || "";
      if (!contentType.includes("application/json")) {
        return null as T;
      }

      return JSON.parse(response.body || "null");
    } catch (err) {
      // Re-throw ApiError as-is
      if (err && typeof err === "object" && "status" in err) {
        throw err;
      }
      // Wrap other errors (timeout, WS disconnect)
      throw {
        status: 0,
        message: err instanceof Error ? err.message : "HTTP bridge request failed",
        details: err,
      } as ApiError;
    }
  }

  /**
   * Standard HTTP fetch (desktop/web-dev mode).
   * Attaches Authorization header for remote browser clients.
   */
  private async requestViaFetch<T>(endpoint: string, options: RequestInit): Promise<T> {
    const baseURL = await getBaseURL();
    const url = `${baseURL}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // Attach Bearer token for remote (non-localhost) browser sessions
    const headers = new Headers(options.headers);
    if (needsRemoteAuth()) {
      const token = getStoredToken();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error: ApiError = {
          status: response.status,
          message: response.statusText,
        };

        try {
          const errorData = await response.json();
          error.details = errorData;
          error.message = errorData.error || errorData.message || error.message;
        } catch {
          // Response is not JSON
        }

        throw error;
      }

      // Handle empty responses
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return null as T;
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw {
            status: 408,
            message: "Request timeout",
            details: error,
          } as ApiError;
        }
        throw {
          status: 0,
          message: error.message,
          details: error,
        } as ApiError;
      }

      throw error;
    }
  }
}

// Export singleton instance
export const apiClient = new ApiClient();
