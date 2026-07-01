/**
 * API Client for FormLogic Backend
 */

import type { Form } from '../types/form';
import { logger } from './logger';
import { addDemoRecord, getDemoRecords, getDemoRecord, updateDemoRecord, deleteDemoRecord, isDemoLocalId } from './demoLocal';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

/** Result of running an onSubmit script via the test endpoint (mirrors ScriptResult). */
export interface DeepHealthCheck {
  ok: boolean;
  critical: boolean;
  detail: string;
  warning?: string;
}

export interface DeepHealth {
  status: string; // 'ok' | 'degraded'
  checks: Record<string, DeepHealthCheck>;
  info?: Record<string, unknown>;
  timestamp: string;
}

export interface ScriptTestResult {
  success: boolean;
  error: string | null;
  rejected: boolean;
  rejectionMessage: string | null;
  status: string | null;
  fields: Record<string, unknown>;
  tags: string[];
  computed: unknown;
  instructionCount: number;
  executionTimeMs: number;
}

export interface PlanUsage {
  enforced: boolean;
  plan: string;
  forms: { used: number; limit: number | null };
  storage: { usedBytes: number; limitBytes: number | null };
}

export interface BillingStatus {
  cloudUntil: string | null;
  active: boolean;
  pricePerMonthCents: number;
  currency: string;
  maxMonths: number;
  paypalEnabled: boolean;
  paypalClientId: string | null;
  usage: PlanUsage | null;
}

class ApiClient {
  private baseUrl: string;
  // Track authentication state without storing the token (it's in HttpOnly cookie)
  private _isAuthenticated: boolean = false;
  // Callbacks invoked when a 401 response invalidates the session (Set prevents duplicates)
  private _onSessionExpiredCallbacks: Set<() => void> = new Set();
  // When true (the shared public Demo account), app-runtime writes stay in this browser's IndexedDB
  // instead of hitting the server, so the demo can't be polluted for other visitors.
  private _demoMode: boolean = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Toggle the demo local-overlay (set from the auth store when the Demo account is active). */
  setDemoMode(on: boolean): void {
    this._demoMode = on;
  }

  /** Whether the shared Demo account is active (writes should stay in the browser). */
  isDemoMode(): boolean {
    return this._demoMode;
  }

  /**
   * Register a callback to be invoked when a 401 response is received,
   * allowing stores to clear user state. Uses a Set to prevent duplicate registrations.
   */
  onSessionExpired(callback: () => void): void {
    this._onSessionExpiredCallbacks.add(callback);
  }

  removeSessionExpiredCallback(callback: () => void): void {
    this._onSessionExpiredCallbacks.delete(callback);
  }

  /**
   * Handle a 401 response — clear local auth state and notify listeners.
   * Only triggers callbacks if we were previously authenticated,
   * to avoid spurious notifications during login/initialization.
   */
  private handleUnauthorized(): void {
    const wasAuthenticated = this._isAuthenticated;
    this._isAuthenticated = false;
    if (wasAuthenticated && this._onSessionExpiredCallbacks.size > 0) {
      for (const cb of this._onSessionExpiredCallbacks) {
        cb();
      }
    }
  }

  /**
   * Read the CSRF token from the non-HttpOnly cookie set by the server.
   */
  private getCsrfToken(): string | null {
    const match = document.cookie.match(/(?:^|;\s*)formlogic_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Mark the client as authenticated (called after successful login/register)
   */
  setAuthenticated(authenticated: boolean): void {
    this._isAuthenticated = authenticated;
  }

  /**
   * Check if user appears to be authenticated
   * Note: This is a client-side hint only. The actual auth check happens server-side via the HttpOnly cookie.
   */
  isAuthenticated(): boolean {
    return this._isAuthenticated;
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

    // Include CSRF token on state-changing requests
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        // Include cookies in requests for HttpOnly cookie authentication
        credentials: 'include',
      });

      let data: T;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          if (response.status === 401) {
            this.handleUnauthorized();
          }
          return { error: `Server error (${response.status})` };
        }
        return { error: 'Invalid response from server' };
      }

      if (!response.ok) {
        if (response.status === 401) {
          this.handleUnauthorized();
        }
        const d = data as Record<string, unknown>;
        let message = (d?.message as string) || 'An error occurred';
        // Surface per-field validation errors so failures are actionable rather
        // than a generic "Validation failed".
        if (d?.errors && typeof d.errors === 'object') {
          const fieldMsgs = Object.values(d.errors as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
          if (fieldMsgs.length > 0) message = `${message}: ${fieldMsgs.join('; ')}`;
        }
        return { error: message };
      }

      return { data };
    } catch (error) {
      logger.error('API request failed:', error);
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  // Auth endpoints
  async register(email: string, password: string, name?: string): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });

    if (result.data?.user) {
      this.setAuthenticated(true);
    }

    return result;
  }

  async login(email: string, password: string): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    if (result.data?.user) {
      this.setAuthenticated(true);
    }

    return result;
  }

  /** Start (or resume) the public no-signup demo — mints a session for the shared "Demo" account. */
  async startDemo(): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User }>('/demo/start', { method: 'POST' });
    if (result.data?.user) {
      this.setAuthenticated(true);
    }
    return result;
  }

  /** Public list of demoable apps (published apps owned by the Demo account). */
  async getDemoApps(): Promise<ApiResponse<{ apps: Array<{ slug: string; name: string; description: string; logoUrl: string | null; packName?: string; tags?: string[] }> }>> {
    return this.request('/demo/apps');
  }

  async requestPasswordReset(email: string): Promise<ApiResponse<{ message: string }>> {
    // The reset-link host is resolved server-side from trusted config — we do
    // NOT send it from the client (that would be a reset-poisoning vector).
    return this.request('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async resetPassword(token: string, password: string): Promise<ApiResponse<{ message: string }>> {
    return this.request('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  async deleteAccount(password: string): Promise<ApiResponse<{ message: string }>> {
    const result = await this.request<{ message: string }>('/auth/me', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    if (!result.error) this.setAuthenticated(false);
    return result;
  }

  // Download the user's account data (GDPR portability) as a JSON file.
  async downloadMyData(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/auth/me/export`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      throw new Error('Failed to export your data');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formlogic-my-data.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Download an app form's responses as CSV (server-gated on the export_responses permission). */
  async exportAppResponses(appSlug: string, formId: string, fileLabel: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/app/${encodeURIComponent(appSlug)}/forms/${encodeURIComponent(formId)}/export`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      throw new Error(response.status === 403 ? 'You do not have permission to export responses.' : 'Failed to export responses');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = (fileLabel || 'form').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'form';
    a.download = `${safe}-responses.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async logout(): Promise<ApiResponse<{ message: string }>> {
    const result = await this.request<{ message: string }>('/auth/logout', {
      method: 'POST',
    });
    this.setAuthenticated(false);
    return result;
  }

  async getMe(): Promise<ApiResponse<{ user: User }>> {
    const result = await this.request<{ user: User }>('/auth/me');
    // Update auth state based on response
    this.setAuthenticated(!!result.data?.user);
    return result;
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

  /** Public, opt-in records for a custom screen's leaderboard (answers only). */
  async getScreenRecords(id: string, opts?: { limit?: number }): Promise<ApiResponse<{ records: Array<{ id: string; answers: Record<string, unknown>; submittedAt: string }> }>> {
    return this.request(`/public/forms/${id}/screen-records${opts?.limit ? `?limit=${opts.limit}` : ''}`);
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

  /** Record a form "start" (first interaction) for the analytics funnel. Fire-and-forget. */
  async recordFormStart(formId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/forms/${formId}/start`, { method: 'POST', credentials: 'include' });
    } catch { /* best-effort: never block the fill on an analytics ping */ }
  }

  // --- Billing (pay-as-you-go cloud months via PayPal) ---
  async getBillingStatus(): Promise<ApiResponse<BillingStatus>> {
    return this.request('/billing');
  }
  async createPaypalOrder(months: number): Promise<ApiResponse<{ orderId: string }>> {
    return this.request('/billing/orders', { method: 'POST', body: JSON.stringify({ months }) });
  }
  async capturePaypalOrder(orderId: string): Promise<ApiResponse<{ cloudUntil: string | null; active: boolean; monthsAdded?: number; alreadyProcessed?: boolean; processing?: boolean; message?: string }>> {
    return this.request(`/billing/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST' });
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

  // Re-run the form's logic script against a stored response
  async recomputeResponse(formId: string, responseId: string): Promise<ApiResponse<{ success: boolean; computed?: Record<string, unknown>; status?: string; tags?: string[]; error?: string }>> {
    return this.request(`/forms/${formId}/responses/${responseId}/recompute`, {
      method: 'POST',
    });
  }

  // Analytics
  async getFormAnalytics(formId: string): Promise<ApiResponse<{ analytics: FormAnalytics }>> {
    return this.request(`/forms/${formId}/analytics`);
  }

  // Export
  async exportResponses(formId: string): Promise<string> {
    const url = `${this.baseUrl}/forms/${formId}/responses/export`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to export responses');
    }

    return response.text();
  }

  // Download SQLite database file
  async downloadSqlite(formId: string, filename: string): Promise<void> {
    const url = `${this.baseUrl}/forms/${formId}/export/sqlite`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to download SQLite database';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${filename}.sqlite`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  }

  // Download JSON export
  async downloadJson(formId: string, filename: string): Promise<void> {
    const url = `${this.baseUrl}/forms/${formId}/export/json`;
    const response = await fetch(url, { credentials: 'include' });

    if (!response.ok) {
      if (response.status === 401) this.handleUnauthorized();
      let message = 'Failed to download JSON export';
      try { const error = await response.json(); message = error.message || message; } catch { /* non-JSON response */ }
      throw new Error(message);
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${filename}-export.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(downloadUrl);
  }

  // Health check
  async healthCheck(): Promise<ApiResponse<{ status: string; timestamp: string }>> {
    return this.request('/health');
  }

  /**
   * Authenticated deep health ("Doctor"). Returns the body even on 503 (degraded) so the UI can
   * render the failing checks. Null on auth failure / network error.
   */
  async getDeepHealth(): Promise<DeepHealth | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health/deep`, { credentials: 'include' });
      if (res.status === 401) { this.handleUnauthorized(); return null; }
      return await res.json();
    } catch {
      return null;
    }
  }

  // AI endpoints
  async getAIStatus(): Promise<ApiResponse<AIStatus>> {
    return this.request('/ai/status');
  }

  async generateFormFromPrompt(
    prompt: string,
    existingFields?: Array<{ id: string; label: string; type: string; required?: boolean }>,
    existingScript?: string,
  ): Promise<ApiResponse<AIFormGenerationResult>> {
    // existingFields/existingScript make this an EDIT of the current form (the AI modifies it,
    // preserving field ids) rather than a from-scratch generation.
    return this.request('/ai/generate-form', {
      method: 'POST',
      body: JSON.stringify({ prompt, existingFields, existingScript }),
    });
  }

  /** AI App Builder: turn a prompt (+ optional reference image data URL) into a multi-form app plan. */
  async generateAppPlan(prompt: string, maxForms = 6, image?: string): Promise<ApiResponse<{ data: import('./ai-app-builder/types').AppPlan }>> {
    return this.request('/ai/generate-app-plan', {
      method: 'POST',
      body: JSON.stringify({ prompt, maxForms, image }),
    });
  }

  /** Generate a custom screen ({ html, css, js }); pass appForms for an APP HOME (multi-form SDK). */
  async generateScreen(
    prompt: string,
    fields?: Array<{ id: string; label: string; type: string }>,
    existing?: string,
    appForms?: Array<{ formId: string; title: string; fields: unknown[] }>,
  ): Promise<ApiResponse<{ data: { html: string; css: string; js: string } }>> {
    return this.request('/ai/generate-screen', {
      method: 'POST',
      body: JSON.stringify({ prompt, fields, existing, appForms }),
    });
  }

  async generateFormFromFile(file: File, prompt?: string): Promise<ApiResponse<AIFormGenerationResult>> {
    const url = `${this.baseUrl}/ai/generate-form-from-file`;
    const formData = new FormData();
    formData.append('file', file);
    if (prompt) {
      formData.append('prompt', prompt);
    }

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        // Include cookies for HttpOnly cookie authentication
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          this.handleUnauthorized();
        }
        // The backend's `error` field is a boolean flag (true), never the message;
        // `data.error ||` short-circuited to `true`, surfacing a useless boolean to
        // the user. Read the human-readable message like the other multipart calls.
        return { error: data.message || 'An error occurred' };
      }

      return { data };
    } catch (error) {
      logger.error('API request failed:', error);
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async generateScript(prompt: string, fields: FormField[], example?: string): Promise<ApiResponse<AIScriptGenerationResult>> {
    return this.request('/ai/generate-script', {
      method: 'POST',
      // `example` is a field-grounded starter script the AI uses as a reference for
      // the correct API shape + this form's real field IDs.
      body: JSON.stringify({ prompt, fields, example }),
    });
  }

  async improveScript(script: string, prompt: string, fields: FormField[]): Promise<ApiResponse<AIScriptGenerationResult>> {
    return this.request('/ai/improve-script', {
      method: 'POST',
      body: JSON.stringify({ script, prompt, fields }),
    });
  }

  /**
   * Run an onSubmit script against sample answers WITHOUT persisting (auth +
   * form ownership required). Powers the ScriptEditor "Test" button.
   */
  async testScript(
    formId: string,
    script: string,
    answers: Record<string, unknown>
  ): Promise<ApiResponse<{ result: ScriptTestResult }>> {
    return this.request(`/forms/${formId}/script/test`, {
      method: 'POST',
      body: JSON.stringify({ script, answers }),
    });
  }

  // App Admin endpoints
  async getApps(): Promise<ApiResponse<{ apps: unknown[]; count: number }>> {
    return this.request('/apps');
  }

  async createApp(data: Record<string, unknown>): Promise<ApiResponse<{ app: unknown }>> {
    return this.request('/apps', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getApp(id: string): Promise<ApiResponse<{ app: unknown }>> {
    return this.request(`/apps/${id}`);
  }

  async updateApp(id: string, data: Record<string, unknown>): Promise<ApiResponse<{ app: unknown }>> {
    return this.request(`/apps/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteApp(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${id}`, {
      method: 'DELETE',
    });
  }

  // App Form management
  async getAppForms(appId: string): Promise<ApiResponse<{ forms: unknown[] }>> {
    return this.request(`/apps/${appId}/forms`);
  }

  // MCP: ephemeral tokens that let an external AI drive the API via the MCP server.
  async createMcpToken(appId?: string, creator = false): Promise<ApiResponse<{ token: string; expiresAt: string; idleTimeout: number; mcpUrl: string }>> {
    return this.request('/mcp/tokens', { method: 'POST', body: JSON.stringify({ appId, creator }) });
  }
  async listMcpTokens(appId?: string): Promise<ApiResponse<{ sessions: Array<{ id: string; appId: string | null; creator?: boolean; scopes?: string[]; expiresAt: string; idleTimeout: number; lastUsedAt: string | null; createdAt: string }> }>> {
    return this.request(`/mcp/tokens${appId ? `?appId=${appId}` : ''}`);
  }
  async revokeMcpToken(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/mcp/tokens/${id}`, { method: 'DELETE' });
  }

  async addAppForm(appId: string, formId: string, displayName?: string): Promise<ApiResponse<{ forms: unknown[] }>> {
    return this.request(`/apps/${appId}/forms`, {
      method: 'POST',
      body: JSON.stringify({ formId, displayName }),
    });
  }

  async updateAppForm(appId: string, formId: string, data: Record<string, unknown>): Promise<ApiResponse<{ forms: unknown[] }>> {
    return this.request(`/apps/${appId}/forms/${formId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async removeAppForm(appId: string, formId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/forms/${formId}`, {
      method: 'DELETE',
    });
  }

  async reorderAppForms(appId: string, formIds: string[]): Promise<ApiResponse<{ forms: unknown[] }>> {
    return this.request(`/apps/${appId}/forms/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ formIds }),
    });
  }

  // App Role management
  async getAppRoles(appId: string): Promise<ApiResponse<{ roles: unknown[] }>> {
    return this.request(`/apps/${appId}/roles`);
  }

  async createAppRole(appId: string, data: { name: string; description?: string }): Promise<ApiResponse<{ role: unknown }>> {
    return this.request(`/apps/${appId}/roles`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateAppRole(appId: string, roleId: string, data: Record<string, unknown>): Promise<ApiResponse<{ roles: unknown[] }>> {
    return this.request(`/apps/${appId}/roles/${roleId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteAppRole(appId: string, roleId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/roles/${roleId}`, {
      method: 'DELETE',
    });
  }

  // App Role Permissions
  async getAppRolePermissions(appId: string, roleId: string): Promise<ApiResponse<{ permissions: unknown[] }>> {
    return this.request(`/apps/${appId}/roles/${roleId}/permissions`);
  }

  async setAppRolePermissions(appId: string, roleId: string, permissions: unknown[]): Promise<ApiResponse<{ permissions: unknown[] }>> {
    return this.request(`/apps/${appId}/roles/${roleId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions }),
    });
  }

  // App User management
  async getAppUsers(appId: string): Promise<ApiResponse<{ users: unknown[]; count: number }>> {
    return this.request(`/apps/${appId}/users`);
  }

  async updateAppUser(appId: string, appUserId: string, data: Record<string, unknown>): Promise<ApiResponse<{ users: unknown[] }>> {
    return this.request(`/apps/${appId}/users/${appUserId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async removeAppUser(appId: string, appUserId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/users/${appUserId}`, {
      method: 'DELETE',
    });
  }

  // App Invitations
  async getAppInvitations(appId: string): Promise<ApiResponse<{ invitations: unknown[] }>> {
    return this.request(`/apps/${appId}/invitations`);
  }

  async createAppInvitation(appId: string, email: string, roleId: string): Promise<ApiResponse<{ invitation: unknown }>> {
    return this.request(`/apps/${appId}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email, roleId }),
    });
  }

  async revokeAppInvitation(appId: string, invitationId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/invitations/${invitationId}`, {
      method: 'DELETE',
    });
  }

  async acceptAppInvitation(token: string): Promise<ApiResponse<{ success: boolean; membership: unknown }>> {
    return this.request('/apps/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  // App Groups
  async getAppGroups(appId: string): Promise<ApiResponse<{ groups: unknown[] }>> {
    return this.request(`/apps/${appId}/groups`);
  }

  async createAppGroup(appId: string, data: { name: string; description?: string }): Promise<ApiResponse<{ group: unknown }>> {
    return this.request(`/apps/${appId}/groups`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateAppGroup(appId: string, groupId: string, data: Record<string, unknown>): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteAppGroup(appId: string, groupId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}`, {
      method: 'DELETE',
    });
  }

  async getAppGroupMembers(appId: string, groupId: string): Promise<ApiResponse<{ members: Array<{ appUserId: string; name: string; email: string }> }>> {
    return this.request(`/apps/${appId}/groups/${groupId}/members`);
  }

  async addAppGroupMember(appId: string, groupId: string, appUserId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}/members/${appUserId}`, {
      method: 'POST',
    });
  }

  async removeAppGroupMember(appId: string, groupId: string, appUserId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/apps/${appId}/groups/${groupId}/members/${appUserId}`, {
      method: 'DELETE',
    });
  }

  // App Runtime endpoints (end-user facing)
  async getAppRuntime(slug: string): Promise<ApiResponse<{ app: unknown; forms: unknown[]; user: unknown; permissions: unknown }>> {
    return this.request(`/app/${slug}`);
  }

  async getAppMyPermissions(slug: string): Promise<ApiResponse<{ permissions: unknown }>> {
    return this.request(`/app/${slug}/my-permissions`);
  }

  async getAppMembership(slug: string): Promise<ApiResponse<{ appName: string; status: string; isMember: boolean; canSelfRegister: boolean }>> {
    return this.request(`/app/${slug}/membership`);
  }

  async joinApp(slug: string): Promise<ApiResponse<{ success: boolean; status: string }>> {
    return this.request(`/app/${slug}/join`, { method: 'POST' });
  }

  async getAppForm(slug: string, formId: string): Promise<ApiResponse<{ form: unknown }>> {
    return this.request(`/app/${slug}/forms/${formId}`);
  }

  async getAppAnalytics(slug: string, formId: string): Promise<ApiResponse<{ analytics: FormAnalytics }>> {
    return this.request(`/app/${slug}/forms/${formId}/analytics`);
  }

  /** Merge server-seeded rows with this browser's local demo records (local shown first, newest). */
  private async _mergeDemoResponses(
    server: ApiResponse<{ responses: unknown[]; count: number; scope: string }>,
    formId: string
  ): Promise<ApiResponse<{ responses: unknown[]; count: number; scope: string }>> {
    const local = await getDemoRecords(formId);
    const serverRows = server.data?.responses ?? [];
    return {
      ...server,
      data: {
        responses: [...local, ...serverRows],
        count: (server.data?.count ?? serverRows.length) + local.length,
        scope: server.data?.scope ?? 'all',
      },
    };
  }

  async createAppResponse(slug: string, formId: string, data: Record<string, unknown>): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode) {
      // Keep demo submissions in this browser only — never touch the shared demo on the server.
      const answers = (data.answers as Record<string, unknown>) ?? {};
      const response = await addDemoRecord(formId, answers);
      return { data: { response } };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getAppResponses(slug: string, formId: string, options?: { limit?: number; offset?: number }): Promise<ApiResponse<{ responses: unknown[]; count: number; scope: string }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    const res = await this.request<{ responses: unknown[]; count: number; scope: string }>(`/app/${slug}/forms/${formId}/responses${query ? `?${query}` : ''}`);
    return this._demoMode ? this._mergeDemoResponses(res, formId) : res;
  }

  /**
   * Server-paginated + searchable page of an app form's responses (returns the total matching count).
   * Used by the records grid for fast, large-dataset browsing. Non-demo only (no browser overlay).
   */
  async getAppResponsesPage(slug: string, formId: string, options: { limit: number; offset: number; search?: string; resolve?: boolean }): Promise<ApiResponse<{ responses: unknown[]; count: number; total: number; scope: string }>> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit));
    params.set('offset', String(options.offset));
    if (options.search) params.set('search', options.search);
    if (options.resolve) params.set('resolve', 'linked');
    return this.request(`/app/${slug}/forms/${formId}/responses?${params.toString()}`);
  }

  async getAppResponseById(slug: string, formId: string, responseId: string): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode && isDemoLocalId(responseId)) {
      const response = await getDemoRecord(formId, responseId);
      return response ? { data: { response } } : { error: 'Record not found' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}`);
  }

  async updateAppResponse(slug: string, formId: string, responseId: string, data: Record<string, unknown>): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode) {
      if (isDemoLocalId(responseId)) {
        const response = await updateDemoRecord(formId, responseId, (data.answers as Record<string, unknown>) ?? {});
        return response ? { data: { response } } : { error: 'Record not found' };
      }
      return { error: 'This is a shared live demo — the seeded data is read-only. Your own entries can be edited.' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteAppResponse(slug: string, formId: string, responseId: string): Promise<ApiResponse<{ success: boolean }>> {
    if (this._demoMode) {
      if (isDemoLocalId(responseId)) {
        await deleteDemoRecord(formId, responseId);
        return { data: { success: true } };
      }
      return { error: 'This is a shared live demo — the seeded data is read-only.' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}`, {
      method: 'DELETE',
    });
  }

  // Linked record lookup
  async lookupLinkedRecords(
    slug: string,
    formId: string,
    options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; offset?: number; ids?: string[] }
  ): Promise<ApiResponse<{ records: LinkedRecord[]; count: number }>> {
    const params = new URLSearchParams();
    params.set('targetFormId', options.targetFormId);
    if (options.displayFieldIds?.length) params.set('displayFieldIds', options.displayFieldIds.join(','));
    if (options.searchFieldIds?.length) params.set('searchFieldIds', options.searchFieldIds.join(','));
    if (options.q) params.set('q', options.q);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.ids?.length) params.set('ids', options.ids.join(','));
    return this.request(`/app/${slug}/forms/${formId}/lookup?${params.toString()}`);
  }

  /**
   * Owner-scoped linked-record lookup (no app context) — powers linked_record fields on standalone /
   * pack forms. Returns only the caller's own records.
   */
  /** Run a no-code report spec against one of an app's forms (read-only, permission-scoped). */
  async runReport(slug: string, spec: Record<string, unknown>): Promise<ApiResponse<import('../types/app').AppReportResult>> {
    return this.request(`/app/${encodeURIComponent(slug)}/reports/run`, {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
  }

  async lookupOwnedRecords(
    formId: string,
    options: { targetFormId: string; displayFieldIds?: string[]; searchFieldIds?: string[]; q?: string; limit?: number; offset?: number; ids?: string[] }
  ): Promise<ApiResponse<{ records: LinkedRecord[]; count: number }>> {
    const params = new URLSearchParams();
    params.set('targetFormId', options.targetFormId);
    if (options.displayFieldIds?.length) params.set('displayFieldIds', options.displayFieldIds.join(','));
    if (options.searchFieldIds?.length) params.set('searchFieldIds', options.searchFieldIds.join(','));
    if (options.q) params.set('q', options.q);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    if (options.ids?.length) params.set('ids', options.ids.join(','));
    return this.request(`/forms/${formId}/lookup?${params.toString()}`);
  }

  // Related records (inverse relations)
  async getRelatedRecords(slug: string, formId: string, responseId: string, options?: { limit?: number; offset?: number }): Promise<ApiResponse<{ related: Record<string, RelatedRecordGroup> }>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}/related${qs ? `?${qs}` : ''}`);
  }

  // Get app responses with resolve option
  async getAppResponsesResolved(slug: string, formId: string, options?: { limit?: number; offset?: number }): Promise<ApiResponse<{ responses: unknown[]; count: number; scope: string }>> {
    const params = new URLSearchParams();
    params.set('resolve', 'linked');
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const res = await this.request<{ responses: unknown[]; count: number; scope: string }>(`/app/${slug}/forms/${formId}/responses?${params.toString()}`);
    return this._demoMode ? this._mergeDemoResponses(res, formId) : res;
  }

  // Get single app response with resolve
  async getAppResponseByIdResolved(slug: string, formId: string, responseId: string): Promise<ApiResponse<{ response: unknown }>> {
    if (this._demoMode && isDemoLocalId(responseId)) {
      const response = await getDemoRecord(formId, responseId);
      return response ? { data: { response } } : { error: 'Record not found' };
    }
    return this.request(`/app/${slug}/forms/${formId}/responses/${responseId}?resolve=linked`);
  }

  // Webhook endpoints
  async getWebhooks(formId: string): Promise<ApiResponse<{ webhooks: Webhook[] }>> {
    return this.request(`/forms/${formId}/webhooks`);
  }

  async createWebhook(formId: string, data: { url: string; events: string[]; description?: string }): Promise<ApiResponse<{ webhook: Webhook & { secret: string } }>> {
    return this.request(`/forms/${formId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateWebhook(formId: string, webhookId: string, data: Partial<{ url: string; events: string[]; is_active: boolean; description: string }>): Promise<ApiResponse<{ webhook: Webhook }>> {
    return this.request(`/forms/${formId}/webhooks/${webhookId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteWebhook(formId: string, webhookId: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/forms/${formId}/webhooks/${webhookId}`, {
      method: 'DELETE',
    });
  }

  async getWebhookDeliveries(formId: string, webhookId: string): Promise<ApiResponse<{ deliveries: WebhookDelivery[] }>> {
    return this.request(`/forms/${formId}/webhooks/${webhookId}/deliveries`);
  }

  // Pack management. catalogId/versionId (from downloadPack) link the install to
  // its marketplace entry so "Installed" state and update checks work.
  async importPack(pack: PackData, opts?: { catalogId?: string; versionId?: string }): Promise<ApiResponse<PackImportResult>> {
    return this.request('/packs/import', {
      method: 'POST',
      body: JSON.stringify({ pack, catalogId: opts?.catalogId, versionId: opts?.versionId }),
    });
  }

  /** Export a whole app (forms + screens + scripts + roles) as a self-contained pack. */
  async exportApp(appId: string): Promise<ApiResponse<{ pack: PackData }>> {
    return this.request(`/apps/${appId}/export`);
  }

  /** Bundled sample apps for the "Try a sample app" gallery. */
  async getSampleApps(): Promise<ApiResponse<{ samples: Array<{ id: string; name: string; description: string; formCount: number }> }>> {
    return this.request('/sample-apps');
  }
  /** Install a bundled sample app into the current account (a fresh copy). */
  async installSampleApp(id: string): Promise<ApiResponse<{ success: boolean; apps: Array<{ id: string; name: string }>; forms: Array<{ id: string; title: string }> }>> {
    return this.request(`/sample-apps/${id}/install`, { method: 'POST' });
  }

  async getInstalledPacks(): Promise<ApiResponse<{ installations: PackInstallation[] }>> {
    return this.request('/packs/installed');
  }

  async uninstallPack(installationId: string): Promise<ApiResponse<PackUninstallResult>> {
    return this.request(`/packs/${installationId}`, { method: 'DELETE' });
  }

  // Pack Marketplace
  async browsePacks(params?: { search?: string; category?: string; tag?: string; sort?: string; page?: number; limit?: number }): Promise<ApiResponse<PackCatalogBrowseResult>> {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.category) qs.set('category', params.category);
    if (params?.tag) qs.set('tag', params.tag);
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return this.request(`/packs/catalog${q ? `?${q}` : ''}`);
  }

  async getPackFacets(): Promise<ApiResponse<PackFacets>> {
    return this.request('/packs/catalog/facets');
  }

  async getPackDetail(slug: string): Promise<ApiResponse<{ pack: CatalogPack & { versions: PackVersionInfo[] } }>> {
    return this.request(`/packs/catalog/${slug}`);
  }

  async publishPack(data: { pack: PackData; name: string; description?: string; tags?: string[]; icon?: string; category?: string; visibility?: string; version?: string; changelog?: string; slug?: string }): Promise<ApiResponse<{ success: boolean; catalogId: string; versionId: string; slug: string }>> {
    return this.request('/packs/catalog', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async publishPackVersion(slug: string, data: { pack: PackData; version: string; changelog?: string }): Promise<ApiResponse<{ success: boolean; versionId: string; version: string }>> {
    return this.request(`/packs/catalog/${slug}/versions`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updatePackMeta(slug: string, meta: Partial<{ name: string; description: string; icon: string; tags: string[]; category: string; visibility: string }>): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/packs/catalog/${slug}`, {
      method: 'PUT',
      body: JSON.stringify(meta),
    });
  }

  async archivePack(slug: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/packs/catalog/${slug}`, { method: 'DELETE' });
  }

  async getMyPacks(): Promise<ApiResponse<{ packs: CatalogPack[] }>> {
    return this.request('/packs/catalog/mine');
  }

  async downloadPack(slug: string, versionId?: string): Promise<ApiResponse<{ pack: PackData; version: string; catalogId: string; versionId: string }>> {
    const qs = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
    return this.request(`/packs/catalog/${slug}/download${qs}`);
  }

  async uploadPackZip(file: File): Promise<ApiResponse<{ success: boolean; pack: PackData; formCount: number; appCount: number }>> {
    const url = `${this.baseUrl}/packs/catalog/upload`;
    const formData = new FormData();
    formData.append('file', file);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to upload pack' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async seedPacks(packs: Array<{ name: string; description?: string; icon?: string; tags?: string[]; category?: string; pack: PackData }>): Promise<ApiResponse<{ success: boolean; seeded: number }>> {
    return this.request('/packs/catalog/seed', {
      method: 'POST',
      body: JSON.stringify({ packs }),
    });
  }

  // Pack Ratings
  async ratePack(slug: string, rating: number, review?: string): Promise<ApiResponse<{ success: boolean; rating: { id: string; rating: number; review: string | null } }>> {
    return this.request(`/packs/catalog/${slug}/ratings`, {
      method: 'POST',
      body: JSON.stringify({ rating, review }),
    });
  }

  async getPackRatings(slug: string, page?: number): Promise<ApiResponse<PackRatingsResult>> {
    const qs = page ? `?page=${page}` : '';
    return this.request(`/packs/catalog/${slug}/ratings${qs}`);
  }

  async deletePackRating(slug: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/packs/catalog/${slug}/ratings`, { method: 'DELETE' });
  }

  // File upload for form responses
  async uploadFile(formId: string, file: File, fieldId?: string): Promise<ApiResponse<UploadedFileMetadata>> {
    const url = `${this.baseUrl}/forms/${formId}/upload`;
    const formData = new FormData();
    formData.append('file', file);
    if (fieldId) formData.append('fieldId', fieldId);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to upload file' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async uploadAppFile(slug: string, formId: string, file: File, fieldId?: string): Promise<ApiResponse<UploadedFileMetadata>> {
    const url = `${this.baseUrl}/app/${slug}/forms/${formId}/upload`;
    const formData = new FormData();
    formData.append('file', file);
    if (fieldId) formData.append('fieldId', fieldId);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to upload file' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  // CSV import
  async parseImportCsv(formId: string, file: File): Promise<ApiResponse<CsvParseResult>> {
    const url = `${this.baseUrl}/forms/${formId}/responses/import`;
    const formData = new FormData();
    formData.append('file', file);

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to parse CSV' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async importCsv(formId: string, file: File, columnMapping: Record<string, string>): Promise<ApiResponse<CsvImportResult>> {
    const url = `${this.baseUrl}/forms/${formId}/responses/import`;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('columnMapping', JSON.stringify(columnMapping));

    try {
      const fetchHeaders: Record<string, string> = {};
      const csrfToken = this.getCsrfToken();
      if (csrfToken) {
        fetchHeaders['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: fetchHeaders,
        credentials: 'include',
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401) this.handleUnauthorized();
        return { error: data.message || 'Failed to import CSV' };
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  // Audit verification
  async verifyAuditIntegrity(): Promise<ApiResponse<AuditVerifyResult>> {
    return this.request('/admin/audit/verify');
  }

  // Form version endpoints
  async getFormVersions(formId: string): Promise<ApiResponse<{ versions: FormVersion[] }>> {
    return this.request(`/forms/${formId}/versions`);
  }

  async getFormVersion(formId: string, version: number): Promise<ApiResponse<{ version: FormVersion }>> {
    return this.request(`/forms/${formId}/versions/${version}`);
  }

  async restoreFormVersion(formId: string, version: number, force = false): Promise<ApiResponse<{ form: Form }>> {
    return this.request(`/forms/${formId}/versions/${version}/restore`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  }

  // API Key management
  async getApiKeys(): Promise<ApiResponse<{ keys: ApiKey[] }>> {
    return this.request('/api-keys');
  }

  async createApiKey(data: { name: string; scopes: string[]; formIds?: string[]; expiresAt?: string }): Promise<ApiResponse<{ key: ApiKeyCreated }>> {
    return this.request('/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async revokeApiKey(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return this.request(`/api-keys/${id}`, {
      method: 'DELETE',
    });
  }
}

// Types
interface User {
  id: string;
  email: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  /** True when this is the shared public "Demo" account (drives the demo banner). */
  isDemo?: boolean;
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

interface AIStatus {
  available: boolean;
  message: string;
}

interface AIGeneratedField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  properties?: Record<string, unknown>;
}

interface AIFormGenerationResult {
  success: boolean;
  data: {
    title: string;
    description?: string;
    fields: AIGeneratedField[];
    needsScript?: boolean;
    suggestedScript?: string;
  };
  pagesProcessed?: number;
}

interface AIScriptGenerationResult {
  success: boolean;
  data: {
    script: string;
    explanation: string;
  };
}

interface FormField {
  id: string;
  type: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  properties?: Record<string, unknown>;
}

interface LinkedRecord {
  id: string;
  display: string;
  fields: Record<string, unknown>;
  submittedAt?: string;
}

interface RelatedRecordGroup {
  formId: string;
  displayName: string;
  fieldLabel: string;
  records: Array<{ id: string; display: string; submittedAt: string }>;
  count: number;
}

interface Webhook {
  id: string;
  formId: string;
  userId: string;
  url: string;
  events: string[];
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  responseStatus: number | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
}

interface FormVersion {
  id: string;
  formId: string;
  version: number;
  changelog: string | null;
  createdAt: string;
  createdBy: string | null;
  data?: Record<string, unknown>;
}

interface PackData {
  formatVersion: number;
  packMeta: { id?: string; name: string; description: string; version: string; author?: string; tags?: string[] };
  forms: Array<Record<string, unknown>>;
  apps?: Array<Record<string, unknown>>;
}

interface PackImportResult {
  success: boolean;
  message: string;
  installationId: string;
  forms: Array<{ id: string; title: string }>;
  apps: Array<{ id: string; name: string }>;
}

interface PackInstallation {
  id: string;
  packId: string;
  catalogId: string | null;
  versionId: string | null;
  packName: string;
  packVersion: string;
  packDescription: string | null;
  formCount: number;
  appCount: number;
  existingFormCount: number;
  existingAppCount: number;
  formIds: string[];
  appIds: string[];
  installedAt: string;
  updateAvailable?: { version: string; changelog: string | null } | null;
}

interface CatalogPack {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  screenshot: string | null;
  screenshots: PackScreenshot[];
  tags: string[];
  category: string | null;
  visibility: string;
  status: string;
  downloadCount: number;
  avgRating: number;
  ratingCount: number;
  featured: boolean;
  publisherId: string;
  publisherName: string | null;
  latestVersion: string | null;
  formCount: number;
  appCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PackScreenshot {
  label: string;
  url: string;
}

interface PackVersionInfo {
  id: string;
  version: string;
  changelog: string | null;
  form_count: number;
  app_count: number;
  created_at: string;
}

interface PackCatalogBrowseResult {
  packs: CatalogPack[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PackFacet {
  name: string;
  count: number;
}

interface PackFacets {
  categories: PackFacet[];
  tags: PackFacet[];
}

interface PackRatingEntry {
  id: string;
  userId: string;
  userName: string;
  rating: number;
  review: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PackRatingsResult {
  ratings: PackRatingEntry[];
  total: number;
  page: number;
  totalPages: number;
  userRating: { rating: number; review: string | null } | null;
}

interface PackUninstallResult {
  success: boolean;
  message: string;
  formsDeleted: number;
  appsDeleted: number;
}

interface CsvParseResult {
  headers: string[];
  rowCount: number;
  previewRows: Array<Record<string, string>>;
  fields: Array<{ id: string; label: string; type: string }>;
}

interface CsvImportResult {
  created: number;
  skipped: number;
  total: number;
  errors: Array<{ row: number; errors: string[] }>;
}

interface AuditVerifyResult {
  intact: boolean;
  verified: number;
  total: number;
  brokenAt: { id: string; sequenceNumber: number; action: string; createdAt: string } | null;
}

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  formIds: string[] | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface ApiKeyCreated extends ApiKey {
  key: string;
}

interface UploadedFileMetadata {
  id: string;
  originalFilename: string;
  storedFilename: string;
  size: number;
  mimeType: string;
  url: string;
}

// Export singleton instance
export const api = new ApiClient(API_BASE_URL);

/**
 * Resolve a server-stored file URL (always root-relative `/api/files/...`) against the
 * configured API base, so uploaded-file downloads work under split-origin deployments
 * (including the dev default where VITE_API_URL points at another port).
 */
export function resolveFileUrl(url?: string | null): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/')) return API_BASE_URL.replace(/\/$/, '') + url.slice(4);
  return url;
}

// Export types
export type { User, FormResponse, FormAnalytics, ApiResponse, AIStatus, AIGeneratedField, AIFormGenerationResult, AIScriptGenerationResult, FormField, LinkedRecord, RelatedRecordGroup, Webhook, WebhookDelivery, FormVersion, PackData, PackImportResult, PackInstallation, PackUninstallResult, CsvParseResult, CsvImportResult, AuditVerifyResult, ApiKey, ApiKeyCreated, CatalogPack, PackScreenshot, PackVersionInfo, PackCatalogBrowseResult, PackFacet, PackFacets, PackRatingEntry, PackRatingsResult, UploadedFileMetadata };
