/**
 * CE↔EE Handshake Client
 *
 * Manages the connection between the Community Edition extension
 * and an optional Enterprise Edition server. Handles:
 * - Server discovery and capabilities exchange
 * - Token-based authentication
 * - Health monitoring
 * - Capability caching
 */

export interface EECapabilities {
  edition: string;
  capabilities: {
    auth: string[];
    audit: string[];
    compliance: string[];
    integrations: string[];
    inference: string[];
  };
}

export interface EEHealthStatus {
  status: string;
  service: string;
  version: string;
}

export interface EELoginResponse {
  provider: string;
  token: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    teamIds: string[];
    active: boolean;
  };
}

export interface EEConnectionState {
  connected: boolean;
  serverUrl: string | null;
  capabilities: EECapabilities | null;
  user: EELoginResponse['user'] | null;
  lastHealthCheck: number | null;
}

export class EEClient {
  private serverUrl: string | null = null;
  private token: string | null = null;
  private capabilities: EECapabilities | null = null;
  private user: EELoginResponse['user'] | null = null;
  private lastHealthCheck: number | null = null;
  private onStateChange: ((state: EEConnectionState) => void) | null = null;

  constructor(opts?: { onStateChange?: (state: EEConnectionState) => void }) {
    this.onStateChange = opts?.onStateChange ?? null;
  }

  getState(): EEConnectionState {
    return {
      connected: !!this.token && !!this.serverUrl,
      serverUrl: this.serverUrl,
      capabilities: this.capabilities,
      user: this.user,
      lastHealthCheck: this.lastHealthCheck,
    };
  }

  isConnected(): boolean {
    return !!this.token && !!this.serverUrl;
  }

  getServerUrl(): string | null {
    return this.serverUrl;
  }

  getCapabilities(): EECapabilities | null {
    return this.capabilities;
  }

  getUser(): EELoginResponse['user'] | null {
    return this.user;
  }

  getToken(): string | null {
    return this.token;
  }

  /**
   * Connect to an EE server: health check → login → capabilities exchange
   */
  async connect(serverUrl: string, email: string): Promise<EEConnectionState> {
    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    this.serverUrl = normalizedUrl;

    // Step 1: Health check
    const health = await this.healthCheck();
    if (health.status !== 'ok') {
      throw new Error(`EE server health check failed: ${health.status}`);
    }

    // Step 2: Login
    const loginResponse = await this.login(email);
    this.token = loginResponse.token;
    this.user = loginResponse.user;

    // Step 3: Capabilities exchange
    this.capabilities = await this.fetchCapabilities();

    this.emitStateChange();
    return this.getState();
  }

  /**
   * Connect using an existing token (e.g. from saved settings)
   */
  async connectWithToken(serverUrl: string, token: string): Promise<EEConnectionState> {
    const normalizedUrl = serverUrl.replace(/\/+$/, '');
    this.serverUrl = normalizedUrl;
    this.token = token;

    // Validate token by fetching current user
    const response = await this.request<{ user: EELoginResponse['user'] }>('/api/v1/auth/me');
    this.user = response.user;

    // Fetch capabilities
    this.capabilities = await this.fetchCapabilities();

    this.emitStateChange();
    return this.getState();
  }

  /**
   * Disconnect from EE server
   */
  disconnect(): void {
    this.token = null;
    this.user = null;
    this.capabilities = null;
    this.serverUrl = null;
    this.lastHealthCheck = null;
    this.emitStateChange();
  }

  /**
   * Health check against the EE server
   */
  async healthCheck(): Promise<EEHealthStatus> {
    const result = await this.request<EEHealthStatus>('/health', { requireAuth: false });
    this.lastHealthCheck = Date.now();
    return result;
  }

  /**
   * Fetch available capabilities from the EE server
   */
  async fetchCapabilities(): Promise<EECapabilities> {
    return this.request<EECapabilities>('/api/v1/capabilities', { requireAuth: false });
  }

  /**
   * Login with email to get a bearer token
   */
  private async login(email: string): Promise<EELoginResponse> {
    return this.request<EELoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: { email, provider: 'oidc' },
      requireAuth: false,
    });
  }

  /**
   * Make an authenticated request to the EE server
   */
  private async request<T>(
    endpoint: string,
    opts: {
      method?: string;
      body?: unknown;
      requireAuth?: boolean;
    } = {},
  ): Promise<T> {
    if (!this.serverUrl) {
      throw new Error('EE server URL not configured');
    }

    const { method = 'GET', body, requireAuth = true } = opts;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (requireAuth && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const fetchOpts: RequestInit = { method, headers };
    if (body) {
      fetchOpts.body = JSON.stringify(body);
    }

    const url = `${this.serverUrl}${endpoint}`;
    const response = await fetch(url, fetchOpts);

    if (response.status === 401) {
      this.token = null;
      this.user = null;
      this.emitStateChange();
      throw new Error('EE authentication expired');
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`EE API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  private emitStateChange(): void {
    this.onStateChange?.(this.getState());
  }
}
