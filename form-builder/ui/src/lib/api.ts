/**
 * API Client for FormLogic Backend
 */

import type { Form } from '../types/form';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api';

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    // Load token from localStorage
    this.token = localStorage.getItem('formlogic_token');
  }

  setToken(token: string | null): void {
    this.token = token;
    if (token) {
      localStorage.setItem('formlogic_token', token);
    } else {
      localStorage.removeItem('formlogic_token');
    }
  }

  getToken(): string | null {
    return this.token;
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        return { error: data.message || 'An error occurred' };
      }

      return { data };
    } catch (error) {
      console.error('API request failed:', error);
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  // Auth endpoints
  async register(email: string, password: string, name?: string): Promise<ApiResponse<{ user: User; token: string }>> {
    const result = await this.request<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });

    if (result.data?.token) {
      this.setToken(result.data.token);
    }

    return result;
  }

  async login(email: string, password: string): Promise<ApiResponse<{ user: User; token: string }>> {
    const result = await this.request<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (result.data?.token) {
      this.setToken(result.data.token);
    }

    return result;
  }

  async logout(): Promise<void> {
    this.setToken(null);
  }

  async getMe(): Promise<ApiResponse<{ user: User }>> {
    return this.request('/auth/me');
  }

  async updateProfile(data: Partial<User>): Promise<ApiResponse<{ user: User }>> {
    return this.request('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Form endpoints
  async getForms(options?: { status?: string; limit?: number; offset?: number }): Promise<ApiResponse<{ forms: Form[]; count: number }>> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const query = params.toString();
    return this.request(`/forms${query ? `?${query}` : ''}`);
  }

  async getForm(id: string): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/forms/${id}`);
  }

  async createForm(data: Partial<Form>): Promise<ApiResponse<{ form: Form }>> {
    return this.request('/forms', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateForm(id: string, data: Partial<Form>): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/forms/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteForm(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/forms/${id}`, {
      method: 'DELETE',
    });
  }

  async duplicateForm(id: string): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/forms/${id}/duplicate`, {
      method: 'POST',
    });
  }

  // Public form endpoint (for form submission)
  async getPublicForm(id: string): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/public/forms/${id}`);
  }

  // Response endpoints
  async getResponses(
    formId: string,
    options?: { status?: string; from?: string; to?: string; limit?: number; offset?: number }
  ): Promise<ApiResponse<{ responses: FormResponse[]; count: number }>> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.from) params.set('from', options.from);
    if (options?.to) params.set('to', options.to);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const query = params.toString();
    return this.request(`/forms/${formId}/responses${query ? `?${query}` : ''}`);
  }

  async getResponse(formId: string, responseId: string): Promise<ApiResponse<{ response: FormResponse }>> {
    return this.request(`/forms/${formId}/responses/${responseId}`);
  }

  async submitResponse(formId: string, data: { answers: Record<string, unknown>; completionTime?: number }): Promise<ApiResponse<{ response: FormResponse }>> {
    return this.request(`/forms/${formId}/responses`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateResponse(formId: string, responseId: string, data: Partial<FormResponse>): Promise<ApiResponse<{ response: FormResponse }>> {
    return this.request(`/forms/${formId}/responses/${responseId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteResponse(formId: string, responseId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/forms/${formId}/responses/${responseId}`, {
      method: 'DELETE',
    });
  }

  // Analytics
  async getFormAnalytics(formId: string): Promise<ApiResponse<{ analytics: FormAnalytics }>> {
    return this.request(`/forms/${formId}/analytics`);
  }

  // Export
  async exportResponses(formId: string): Promise<string> {
    const url = `${this.baseUrl}/forms/${formId}/responses/export`;
    const headers: Record<string, string> = {};

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, { headers });
    return response.text();
  }

  // Health check
  async healthCheck(): Promise<ApiResponse<{ status: string; timestamp: string }>> {
    return this.request('/health');
  }
}

// Types
interface User {
  id: string;
  email: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface FormResponse {
  id: string;
  answers: Record<string, unknown>;
  status: 'draft' | 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'archived';
  submittedAt: string;
  updatedAt?: string;
  metadata?: {
    userAgent?: string;
    referrer?: string;
    completionTime?: number;
    ipAddress?: string;
  };
}

interface FormAnalytics {
  totalResponses: number;
  totalViews?: number;
  totalStarts?: number;
  completionRate: number;
  averageCompletionTime: number;
  responsesByDate: Array<{ date: string; count: number }>;
}

// Export singleton instance
export const api = new ApiClient(API_BASE_URL);

// Export types
export type { User, FormResponse, FormAnalytics, ApiResponse };
