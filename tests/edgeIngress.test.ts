import { describe, expect, test } from "bun:test";
import type { DigitalOceanClientLike } from "../src/digitalocean";
import { createDigitalOceanIngressProvider } from "../src/digitaloceanIngress";
import type { GcpComputeRequest } from "../src/gcp";
import { createGcpIngressProvider } from "../src/gcpIngress";
import {
  EdgeIngressValidationError,
  validateEdgeIngressSpec,
  type EdgeIngressSpec,
} from "../src/edgeIngress";

const spec = (): EdgeIngressSpec => ({
  backends: [
    { priority: 2, region: "sfo3", resourceId: "regional-west" },
    { priority: 1, region: "nyc3", resourceId: "regional-east" },
  ],
  healthCheck: { path: "/healthz", port: 3002, protocol: "http" },
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  listener: {
    port: 443,
    protocol: "https",
    targetPort: 443,
    tlsPassthrough: true,
  },
  name: "absolutejs-edge",
});

describe("global edge ingress contract", () => {
  test("rejects duplicate regional resources and invalid listener state", () => {
    const input = spec();
    input.backends = [input.backends[0]!, input.backends[0]!];
    expect(() => validateEdgeIngressSpec(input)).toThrow(
      EdgeIngressValidationError,
    );
  });

  test("creates and updates one DigitalOcean global load balancer by name", async () => {
    const calls: Array<{ body?: unknown; method: string; path: string }> = [];
    let existing = false;
    const client: DigitalOceanClientLike = {
      request: async <T>(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        calls.push({ body, method, path });
        if (method === "GET")
          return {
            load_balancers: existing
              ? [
                  {
                    id: "global-id",
                    ip: "203.0.113.10",
                    name: "absolutejs-edge",
                    status: "active",
                    type: "GLOBAL",
                  },
                ]
              : [],
          } as T;
        existing = true;

        return {
          load_balancer: {
            id: "global-id",
            ip: "203.0.113.10",
            name: "absolutejs-edge",
            status: "active",
          },
        } as T;
      },
    };
    const provider = createDigitalOceanIngressProvider({ client });
    const created = await provider.reconcileIngress(spec());
    const updated = await provider.reconcileIngress(spec());

    expect(created).toMatchObject({
      addresses: ["203.0.113.10"],
      provider: "digitalocean",
      state: "ready",
    });
    expect(updated.id).toBe(created.id);
    expect(calls.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "GET",
      "PUT",
    ]);
    expect(calls[1]?.body).toMatchObject({
      glb_settings: {
        region_priorities: { nyc3: 1, sfo3: 2 },
        target_load_balancer_ids: ["regional-east", "regional-west"],
      },
      network_stack: "DUALSTACK",
      type: "GLOBAL",
    });
  });

  test("reconciles and removes a complete GCP global TCP ingress", async () => {
    const resources = new Map<string, Record<string, unknown>>();
    const calls: Array<{ data?: unknown; method?: string; url: string }> = [];
    const request: GcpComputeRequest = async <T>(input: {
      data?: unknown;
      method?: string;
      url: string;
    }) => {
      calls.push(input);
      const url = new URL(input.url);
      const resourcePath = url.pathname.replace(
        "/compute/v1/projects/paas/global/",
        "",
      );
      if (!input.method) {
        const resource = resources.get(resourcePath);
        if (!resource) throw { response: { status: 404 } };

        return { data: resource as T };
      }
      if (input.method === "DELETE") {
        resources.delete(resourcePath);

        return { data: { name: "operation", status: "DONE" } as T };
      }
      const collection = resourcePath.split("/")[0]!;
      const data = input.data as { name?: string };
      const name = data.name ?? resourcePath.split("/")[1]!;
      const path = `${collection}/${name}`;
      const resource = {
        ...data,
        ...(collection === "addresses"
          ? { address: "203.0.113.20", status: "RESERVED" }
          : {}),
        name,
        selfLink: `https://compute.googleapis.com/${path}`,
      };
      resources.set(path, resource);

      return { data: { name: "operation", status: "DONE" } as T };
    };
    const provider = createGcpIngressProvider({
      authRequest: request,
      projectId: "paas",
    });
    const input = spec();
    input.backends = [
      {
        region: "us-east1",
        resourceId:
          "https://compute.googleapis.com/projects/paas/zones/us-east1-b/instanceGroups/edge-east",
      },
      {
        region: "us-west1",
        resourceId:
          "https://compute.googleapis.com/projects/paas/zones/us-west1-a/instanceGroups/edge-west",
      },
    ];
    const ingress = await provider.reconcileIngress(input);

    expect(ingress).toMatchObject({
      addresses: ["203.0.113.20"],
      provider: "gcp",
      state: "ready",
    });
    expect(
      resources.get("backendServices/absolutejs-edge-backend"),
    ).toMatchObject({
      loadBalancingScheme: "EXTERNAL_MANAGED",
      protocol: "TCP",
    });
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(5);

    await provider.removeIngress(input.name, input.idempotencyKey);
    expect(resources.size).toBe(0);
  });
});
