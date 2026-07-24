import type { InfrastructureNode } from "./infrastructure";

/** A short-lived compute and storage allocation with independently observable cleanup. */
export type EphemeralInfrastructureResources = {
  node: InfrastructureNode;
  volume: {
    encryptedAtRest: true;
    id: string;
    label: string;
    region: string;
    sizeGiB: number;
  };
};

export type ProvisionEphemeralInfrastructure = {
  idempotencyKey: string;
  image: string | number;
  name: string;
  region: string;
  size: string;
  sshKeys: ReadonlyArray<string | number>;
  userData: string;
  volumeGiB: number;
  vpcUuid: string;
};

export type EphemeralInfrastructureAbsence = {
  dropletAbsent: boolean;
  volumeAbsent: boolean;
};

/**
 * Provider-owned lifecycle for isolated experiments. It deliberately contains
 * no remote-command primitive: the provisioned image decides what can run.
 */
export type EphemeralInfrastructureProvider = {
  cleanup: (
    resources: EphemeralInfrastructureResources,
  ) => Promise<EphemeralInfrastructureAbsence>;
  inspectAbsence: (
    resources: EphemeralInfrastructureResources,
  ) => Promise<EphemeralInfrastructureAbsence>;
  name: string;
  provision: (
    request: ProvisionEphemeralInfrastructure,
  ) => Promise<EphemeralInfrastructureResources>;
};
