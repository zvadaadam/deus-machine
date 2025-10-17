/**
 * Base API Client
 * Handles HTTP requests with proper error handling and type safety
 */

import { API_CONFIG } from '../config/api.config';
import type { ApiError } from '../types';

class ApiClient {
  private baseURL: string;
  private timeout: number;

  constructor(baseURL: string = API_CONFIG.BASE_URL, timeout: number = API_CONFIG.REQUEST_TIMEOUT) {
    this.baseURL = baseURL;
    this.timeout = timeout;
  }

  /**
   * Generic GET request
   */
  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  /**
   * Generic POST request
   */
  async post<T>(endpoint: string, data?: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  /**
   * Generic PATCH request
   */
  async patch<T>(endpoint: string, data: any): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  /**
   * Generic DELETE request
   */
  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }

  /**
   * Core request method with timeout and error handling
   */
  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error: ApiError = {
          status: response.status,
          message: response.statusText,
        };

        // Try to parse error details
        try {
          const errorData = await response.json();
          error.details = errorData;
          error.message = errorData.message || error.message;
        } catch {
          // Response is not JSON, use status text
        }

        throw error;
      }

      // Handle empty responses
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return null as T;
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw {
            status: 408,
            message: 'Request timeout',
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
