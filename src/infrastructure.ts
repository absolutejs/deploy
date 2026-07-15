/** Shared compute-fleet contract implemented by every cloud adapter. */
export type InfrastructureNodeState = "pending" | "ready" | "terminated";

export type InfrastructureNode = {
  id: string;
  label: string;
  provider: string;
  region: string;
  state: InfrastructureNodeState;
  publicIpv4?: string;
  privateIpv4?: string;
  agent?: {
    audience?: string;
    url: string;
  };
};

export type InfrastructureProviderCapabilities = {
  cloudInit: boolean;
  idempotentProvisioning: boolean;
  privateNetworking: boolean;
  regionalPlacement: boolean;
  regions: readonly string[];
};

export type ProvisionInfrastructureNode = {
  idempotencyKey: string;
  name: string;
  region?: string;
};

export type InfrastructureProvider = {
  capabilities: InfrastructureProviderCapabilities;
  getNode: (id: string) => Promise<InfrastructureNode>;
  listNodes: () => Promise<InfrastructureNode[]>;
  name: string;
  provisionNode: (
    request: ProvisionInfrastructureNode,
  ) => Promise<InfrastructureNode>;
  terminateNode: (id: string, idempotencyKey: string) => Promise<void>;
};
