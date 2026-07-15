/** GCP global external TCP proxy adapter for regional edge backend groups. */
import { GoogleAuth } from "google-auth-library";
import type { GcpComputeRequest } from "./gcp";
import {
  normalizedEdgeIngressBackends,
  validateEdgeIngressSpec,
  type EdgeIngress,
  type EdgeIngressBackend,
  type EdgeIngressProvider,
  type EdgeIngressSpec,
} from "./edgeIngress";

const COMPUTE_BASE_URL = "https://compute.googleapis.com/compute/v1";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const OPERATION_POLL_MS = 500;

type GcpResource = {
  address?: string;
  backends?: Array<{ group: string }>;
  healthChecks?: string[];
  name: string;
  portRange?: string;
  selfLink: string;
  service?: string;
  status?: string;
  target?: string;
};

type GcpOperation = {
  error?: { errors?: Array<{ message?: string }> };
  name: string;
  status?: "PENDING" | "RUNNING" | "DONE";
};

export type GcpIngressProviderOptions = {
  authRequest?: GcpComputeRequest;
  operationTimeoutMs?: number;
  portName?: string;
  projectId: string;
};

export class GcpIngressError extends Error {}

const errorStatus = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const response = "response" in error ? error.response : null;
  if (!response || typeof response !== "object") return null;

  return "status" in response && typeof response.status === "number"
    ? response.status
    : null;
};

const sameResources = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const normalizeBackends = (backends: readonly EdgeIngressBackend[]) =>
  normalizedEdgeIngressBackends(backends).map(({ resourceId }) => ({
    balancingMode: "UTILIZATION",
    group: resourceId,
    maxUtilization: 0.8,
  }));

export const createGcpIngressProvider = (
  options: GcpIngressProviderOptions,
): EdgeIngressProvider => {
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const request: GcpComputeRequest =
    options.authRequest ?? ((input) => auth.request(input));
  const root = `${COMPUTE_BASE_URL}/projects/${encodeURIComponent(options.projectId)}`;
  const names = (name: string) => ({
    address: `${name}-ip`,
    backend: `${name}-backend`,
    forwarding: `${name}-forwarding`,
    health: `${name}-health`,
    proxy: `${name}-proxy`,
  });
  const get = async (collection: string, name: string) => {
    try {
      const response = await request<GcpResource>({
        url: `${root}/global/${collection}/${encodeURIComponent(name)}`,
      });

      return response.data;
    } catch (error) {
      if (errorStatus(error) === 404) return null;
      throw error;
    }
  };
  const wait = async (operation: GcpOperation) => {
    if (operation.status === "DONE") {
      const message = operation.error?.errors?.[0]?.message;
      if (message) throw new GcpIngressError(message);

      return;
    }
    const startedAt = Date.now();
    let current = operation;
    while (current.status !== "DONE") {
      if (
        Date.now() - startedAt >
        (options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS)
      )
        throw new GcpIngressError(
          `Timed out waiting for GCP operation ${operation.name}`,
        );
      await Bun.sleep(OPERATION_POLL_MS);
      current = (
        await request<GcpOperation>({
          url: `${root}/global/operations/${encodeURIComponent(operation.name)}`,
        })
      ).data;
    }
    const message = current.error?.errors?.[0]?.message;
    if (message) throw new GcpIngressError(message);
  };
  const mutate = async (
    collection: string,
    method: "POST" | "PATCH" | "DELETE",
    name: string,
    data?: unknown,
  ) => {
    const suffix = method === "POST" ? "" : `/${encodeURIComponent(name)}`;
    const operation = await request<GcpOperation>({
      ...(data === undefined ? {} : { data }),
      method,
      url: `${root}/global/${collection}${suffix}`,
    });
    await wait(operation.data);
  };
  const snapshot = (
    name: string,
    address: GcpResource | null,
    forwarding: GcpResource | null,
    backends: readonly EdgeIngressBackend[] = [],
  ): EdgeIngress => ({
    addresses: address?.address ? [address.address] : [],
    backends: normalizedEdgeIngressBackends(backends),
    id: `gcp:${name}`,
    name,
    provider: "gcp",
    state:
      address?.status === "RESERVED" && forwarding ? "ready" : "provisioning",
  });

  return {
    capabilities: {
      automaticHealthFailover: true,
      global: true,
      tlsPassthrough: true,
    },
    getIngress: async (name) => {
      const resourceNames = names(name);
      const [address, forwarding] = await Promise.all([
        get("addresses", resourceNames.address),
        get("forwardingRules", resourceNames.forwarding),
      ]);
      if (!address && !forwarding) return null;

      return snapshot(name, address, forwarding);
    },
    name: "gcp",
    reconcileIngress: async (spec) => {
      validateEdgeIngressSpec(spec);
      if (!spec.listener.tlsPassthrough)
        throw new GcpIngressError(
          "GCP edge ingress requires TLS passthrough to the regional edge",
        );
      const resourceNames = names(spec.name);
      let health = await get("healthChecks", resourceNames.health);
      if (!health) {
        const healthProtocol = spec.healthCheck.protocol.toUpperCase();
        const healthConfiguration =
          spec.healthCheck.protocol === "tcp"
            ? { tcpHealthCheck: { port: spec.healthCheck.port } }
            : spec.healthCheck.protocol === "https"
              ? {
                  httpsHealthCheck: {
                    port: spec.healthCheck.port,
                    requestPath: spec.healthCheck.path ?? "/healthz",
                  },
                }
              : {
                  httpHealthCheck: {
                    port: spec.healthCheck.port,
                    requestPath: spec.healthCheck.path ?? "/healthz",
                  },
                };
        await mutate("healthChecks", "POST", resourceNames.health, {
          checkIntervalSec: 10,
          healthyThreshold: 2,
          ...healthConfiguration,
          name: resourceNames.health,
          timeoutSec: 5,
          type: healthProtocol,
          unhealthyThreshold: 3,
        });
        health = await get("healthChecks", resourceNames.health);
      }
      if (!health)
        throw new GcpIngressError("GCP health check was not created");

      const desiredBackends = normalizeBackends(spec.backends);
      const desiredGroups = desiredBackends.map(({ group }) => group);
      let backend = await get("backendServices", resourceNames.backend);
      const backendData = {
        backends: desiredBackends,
        connectionDraining: { drainingTimeoutSec: 30 },
        healthChecks: [health.selfLink],
        loadBalancingScheme: "EXTERNAL_MANAGED",
        name: resourceNames.backend,
        portName: options.portName ?? "https",
        protocol: "TCP",
        timeoutSec: 300,
      };
      if (!backend) {
        await mutate(
          "backendServices",
          "POST",
          resourceNames.backend,
          backendData,
        );
        backend = await get("backendServices", resourceNames.backend);
      } else if (
        !sameResources(
          backend.backends?.map(({ group }) => group) ?? [],
          desiredGroups,
        ) ||
        !sameResources(backend.healthChecks ?? [], [health.selfLink])
      ) {
        await mutate(
          "backendServices",
          "PATCH",
          resourceNames.backend,
          backendData,
        );
        backend = await get("backendServices", resourceNames.backend);
      }
      if (!backend)
        throw new GcpIngressError("GCP backend service was not created");

      let proxy = await get("targetTcpProxies", resourceNames.proxy);
      if (!proxy) {
        await mutate("targetTcpProxies", "POST", resourceNames.proxy, {
          name: resourceNames.proxy,
          proxyHeader: "NONE",
          service: backend.selfLink,
        });
        proxy = await get("targetTcpProxies", resourceNames.proxy);
      } else if (proxy.service !== backend.selfLink) {
        await mutate("targetTcpProxies", "PATCH", resourceNames.proxy, {
          service: backend.selfLink,
        });
        proxy = await get("targetTcpProxies", resourceNames.proxy);
      }
      if (!proxy) throw new GcpIngressError("GCP target proxy was not created");

      let address = await get("addresses", resourceNames.address);
      if (!address) {
        await mutate("addresses", "POST", resourceNames.address, {
          addressType: "EXTERNAL",
          ipVersion: "IPV4",
          name: resourceNames.address,
          networkTier: "PREMIUM",
        });
        address = await get("addresses", resourceNames.address);
      }
      if (!address) throw new GcpIngressError("GCP address was not reserved");

      let forwarding = await get("forwardingRules", resourceNames.forwarding);
      const portRange = `${spec.listener.port}-${spec.listener.port}`;
      const forwardingData = {
        IPAddress: address.address,
        IPProtocol: "TCP",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        name: resourceNames.forwarding,
        networkTier: "PREMIUM",
        portRange,
        target: proxy.selfLink,
      };
      if (!forwarding) {
        await mutate(
          "forwardingRules",
          "POST",
          resourceNames.forwarding,
          forwardingData,
        );
        forwarding = await get("forwardingRules", resourceNames.forwarding);
      } else if (
        forwarding.target !== proxy.selfLink ||
        forwarding.portRange !== portRange
      ) {
        await mutate(
          "forwardingRules",
          "PATCH",
          resourceNames.forwarding,
          forwardingData,
        );
        forwarding = await get("forwardingRules", resourceNames.forwarding);
      }
      if (!forwarding)
        throw new GcpIngressError("GCP forwarding rule was not created");

      return snapshot(spec.name, address, forwarding, spec.backends);
    },
    removeIngress: async (name) => {
      const resourceNames = names(name);
      const resources = [
        ["forwardingRules", resourceNames.forwarding],
        ["targetTcpProxies", resourceNames.proxy],
        ["backendServices", resourceNames.backend],
        ["healthChecks", resourceNames.health],
        ["addresses", resourceNames.address],
      ] as const;
      for (const [collection, resourceName] of resources) {
        if (await get(collection, resourceName))
          await mutate(collection, "DELETE", resourceName);
      }
    },
  };
};
