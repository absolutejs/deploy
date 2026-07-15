/** Provider-neutral lifecycle for a global ingress in front of regional edge pools. */

export type EdgeIngressProtocol = "tcp" | "http" | "https";

export type EdgeIngressBackend = {
  /** Provider-native regional pool id (for example a DO regional LB UUID or GCP group self-link). */
  resourceId: string;
  region: string;
  /** Lower values are preferred during regional failover. */
  priority?: number;
};

export type EdgeIngressSpec = {
  backends: readonly EdgeIngressBackend[];
  healthCheck: {
    path?: string;
    port: number;
    protocol: EdgeIngressProtocol;
  };
  idempotencyKey: string;
  listener: {
    port: number;
    protocol: EdgeIngressProtocol;
    targetPort: number;
    tlsPassthrough?: boolean;
  };
  name: string;
};

export type EdgeIngressState = "provisioning" | "ready" | "degraded";

export type EdgeIngress = {
  addresses: string[];
  backends: EdgeIngressBackend[];
  id: string;
  name: string;
  provider: string;
  state: EdgeIngressState;
};

export type EdgeIngressCapabilities = {
  automaticHealthFailover: boolean;
  global: boolean;
  tlsPassthrough: boolean;
};

export type EdgeIngressProvider = {
  capabilities: EdgeIngressCapabilities;
  getIngress: (name: string) => Promise<EdgeIngress | null>;
  name: string;
  reconcileIngress: (spec: EdgeIngressSpec) => Promise<EdgeIngress>;
  removeIngress: (name: string, idempotencyKey: string) => Promise<void>;
};

const validPort = (port: number) =>
  Number.isInteger(port) && port >= 1 && port <= 65_535;

export class EdgeIngressValidationError extends Error {}

export const validateEdgeIngressSpec = (spec: EdgeIngressSpec) => {
  if (!/^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(spec.name))
    throw new EdgeIngressValidationError("Invalid edge ingress name");
  if (spec.backends.length === 0)
    throw new EdgeIngressValidationError(
      "Edge ingress requires at least one regional backend",
    );
  if (!validPort(spec.listener.port) || !validPort(spec.listener.targetPort))
    throw new EdgeIngressValidationError("Invalid edge ingress listener port");
  if (!validPort(spec.healthCheck.port))
    throw new EdgeIngressValidationError("Invalid edge ingress health port");
  const resources = new Set<string>();
  for (const backend of spec.backends) {
    if (!backend.resourceId || !backend.region)
      throw new EdgeIngressValidationError("Invalid edge ingress backend");
    if (resources.has(backend.resourceId))
      throw new EdgeIngressValidationError("Duplicate edge ingress backend");
    resources.add(backend.resourceId);
  }
  if (
    spec.listener.tlsPassthrough &&
    spec.listener.protocol !== "https" &&
    spec.listener.protocol !== "tcp"
  )
    throw new EdgeIngressValidationError(
      "TLS passthrough requires an HTTPS or TCP listener",
    );

  return spec;
};

export const normalizedEdgeIngressBackends = (
  backends: readonly EdgeIngressBackend[],
) =>
  [...backends].sort(
    (left, right) =>
      (left.priority ?? Number.MAX_SAFE_INTEGER) -
        (right.priority ?? Number.MAX_SAFE_INTEGER) ||
      left.region.localeCompare(right.region) ||
      left.resourceId.localeCompare(right.resourceId),
  );
