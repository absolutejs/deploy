import type { InfrastructureNode } from "./infrastructure";

export type InfrastructureAgentOptions = {
  audience?: string;
  port?: number;
  preferPrivateNetwork?: boolean;
  protocol?: "http" | "https";
};

export const infrastructureAgent = (
  options: InfrastructureAgentOptions | undefined,
  addresses: Pick<InfrastructureNode, "privateIpv4" | "publicIpv4">,
) => {
  if (!options) return undefined;
  const host = options.preferPrivateNetwork
    ? (addresses.privateIpv4 ?? addresses.publicIpv4)
    : (addresses.publicIpv4 ?? addresses.privateIpv4);
  if (!host) return undefined;

  return {
    url: `${options.protocol ?? "http"}://${host}:${options.port ?? 8081}/`,
    ...(options.audience ? { audience: options.audience } : {}),
  };
};

export const leastPopulatedRegion = <Region extends { region: string }>(
  regions: readonly Region[],
  observed: readonly string[],
  requested?: string,
) => {
  const eligible = requested
    ? regions.filter((region) => region.region === requested)
    : [...regions];
  if (eligible.length === 0) return undefined;
  const counts = new Map(eligible.map((region) => [region.region, 0]));
  for (const region of observed) {
    if (counts.has(region)) counts.set(region, (counts.get(region) ?? 0) + 1);
  }
  const selected = [...counts].sort(
    (left, right) =>
      left[1] - right[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];

  return eligible.find((region) => region.region === selected);
};
