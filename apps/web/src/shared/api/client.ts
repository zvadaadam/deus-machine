/**
 * Base API Client
 * Handles HTTP requests with proper error handling and type safety
 *
 * Now supports dynamic port allocation.
 * Attaches Bearer token for remote (non-localhost) browser clients.
 */

import { getBaseURL } from "../config/api.config";
import { getStoredToken, needsRemoteAuth } from "@/features/auth";
import type { ApiError } from "../types";

/** Request timeout in milliseconds. */
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
   * Attaches Authorization header for remote browser clients.
   */
  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
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
