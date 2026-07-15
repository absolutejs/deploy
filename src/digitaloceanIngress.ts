/** DigitalOcean Global Load Balancer adapter for regional edge pools. */
import {
  createDigitalOceanClient,
  type DigitalOceanClientLike,
} from "./digitalocean";
import {
  normalizedEdgeIngressBackends,
  validateEdgeIngressSpec,
  type EdgeIngress,
  type EdgeIngressProvider,
  type EdgeIngressSpec,
} from "./edgeIngress";

type DigitalOceanLoadBalancer = {
  id: string;
  ip?: string;
  ipv6?: string;
  name: string;
  status?: "new" | "active" | "errored";
  type?: "GLOBAL" | "REGIONAL" | "REGIONAL_NETWORK";
};

export type DigitalOceanIngressProviderOptions = {
  client?: DigitalOceanClientLike;
  networkStack?: "IPV4" | "DUALSTACK";
  token?: string;
};

const resolveClient = (options: DigitalOceanIngressProviderOptions) => {
  if (options.client) return options.client;
  if (options.token) return createDigitalOceanClient(options.token);
  throw new Error(
    "[deploy/digitalocean-ingress] either `token` or `client` must be provided",
  );
};

const normalize = (
  loadBalancer: DigitalOceanLoadBalancer,
  backends: EdgeIngressSpec["backends"] = [],
): EdgeIngress => ({
  addresses: [loadBalancer.ip, loadBalancer.ipv6].filter(
    (address): address is string => Boolean(address),
  ),
  backends: normalizedEdgeIngressBackends(backends),
  id: `digitalocean:${loadBalancer.id}`,
  name: loadBalancer.name,
  provider: "digitalocean",
  state:
    loadBalancer.status === "active"
      ? "ready"
      : loadBalancer.status === "errored"
        ? "degraded"
        : "provisioning",
});

export const createDigitalOceanIngressProvider = (
  options: DigitalOceanIngressProviderOptions,
): EdgeIngressProvider => {
  const client = resolveClient(options);
  const find = async (name: string) => {
    const response = await client.request<{
      load_balancers: DigitalOceanLoadBalancer[];
    }>("GET", "/load_balancers");
    const matches = response.load_balancers.filter(
      (loadBalancer) => loadBalancer.name === name,
    );
    if (matches.length > 1)
      throw new Error(
        `[deploy/digitalocean-ingress] multiple load balancers named ${name}`,
      );

    return matches[0] ?? null;
  };

  return {
    capabilities: {
      automaticHealthFailover: true,
      global: true,
      tlsPassthrough: true,
    },
    getIngress: async (name) => {
      const existing = await find(name);

      return existing ? normalize(existing) : null;
    },
    name: "digitalocean",
    reconcileIngress: async (spec) => {
      validateEdgeIngressSpec(spec);
      if (spec.listener.protocol === "tcp")
        throw new Error(
          "[deploy/digitalocean-ingress] Global Load Balancers require an HTTP-family listener",
        );
      const backends = normalizedEdgeIngressBackends(spec.backends);
      const existing = await find(spec.name);
      const body = {
        forwarding_rules: [
          {
            entry_port: spec.listener.port,
            entry_protocol: spec.listener.protocol,
            target_port: spec.listener.targetPort,
            target_protocol: spec.listener.protocol,
            ...(spec.listener.tlsPassthrough ? { tls_passthrough: true } : {}),
          },
        ],
        glb_settings: {
          region_priorities: Object.fromEntries(
            backends.map((backend, index) => [
              backend.region,
              backend.priority ?? index + 1,
            ]),
          ),
          target_load_balancer_ids: backends.map(
            (backend) => backend.resourceId,
          ),
          target_port: spec.listener.targetPort,
          target_protocol: spec.listener.protocol,
        },
        health_check: {
          path: spec.healthCheck.path ?? "/healthz",
          port: spec.healthCheck.port,
          protocol: spec.healthCheck.protocol,
        },
        name: spec.name,
        network_stack: options.networkStack ?? "DUALSTACK",
        type: "GLOBAL",
      };
      const response = existing
        ? await client.request<{ load_balancer: DigitalOceanLoadBalancer }>(
            "PUT",
            `/load_balancers/${encodeURIComponent(existing.id)}`,
            body,
          )
        : await client.request<{ load_balancer: DigitalOceanLoadBalancer }>(
            "POST",
            "/load_balancers",
            body,
          );

      return normalize(response.load_balancer, backends);
    },
    removeIngress: async (name) => {
      const existing = await find(name);
      if (existing)
        await client.request(
          "DELETE",
          `/load_balancers/${encodeURIComponent(existing.id)}`,
        );
    },
  };
};
