import type { Plugin, PluginInput } from "@opencode-ai/plugin";

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModel {
  cost?: {
    input: number;
    output: number;
  };
  [key: string]: unknown;
}

export interface Provider {
  models?: Record<string, ProviderModel>;
}

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}


export type PluginClient = PluginInput['client'];

export interface PluginContext {
  client: PluginClient;
  directory: string;
}

export type PluginResult = Awaited<ReturnType<Plugin>>;


export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface MultiAccountRefreshParts {
  accounts: RefreshParts[];
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}
