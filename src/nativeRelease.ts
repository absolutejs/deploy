import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PREFIX = "absolutejs/native-releases";
const DEFAULT_MAX_ARTIFACT_BYTES = 2_147_483_648;
export const NATIVE_RELEASE_REGISTRY_FORMAT = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APP_ID_PATTERN = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CERTIFICATION_ID_PATTERN = /^amobile_cert_[a-f0-9]{64}$/;
const MAX_CERTIFICATION_VERIFICATION_BYTES = 1_048_576;

export type AndroidNativeReleaseMetadata = {
  appBuild: string;
  appId: string;
  artifact: "app-release.aab";
  bytes: number;
  engine: "capacitor" | "expo";
  format: 1;
  platform: "android";
  releaseId: string;
  runtime: string;
  sha256: string;
  signed: boolean;
  type: "aab";
  versionCode?: number;
};

export type IosNativeReleaseMetadata = {
  appBuild: string;
  appId: string;
  artifact: "App.ipa";
  buildNumber?: number;
  bytes: number;
  engine: "capacitor" | "expo";
  format: 1;
  marketingVersion: string;
  platform: "ios";
  releaseId: string;
  runtime: string;
  sha256: string;
  signed: boolean;
  type: "ipa";
};

export type NativeReleaseMetadata =
  | AndroidNativeReleaseMetadata
  | IosNativeReleaseMetadata;

export type NativeReleaseCertificationRequirement =
  | "installed"
  | "simulator"
  | "device"
  | "store";

export type NativeReleaseCertification = {
  certificationId: string;
  evidence: Array<{
    artifactExactness?:
      | "archive-equivalent"
      | "source-equivalent"
      | "store-delivered";
    distribution?:
      | "apple-processed"
      | "registered-device"
      | "simulator-release";
    generatedAt: string;
    networkUnavailable: "not-proven" | "proven";
    remote: boolean;
    reportSha256: string;
    strength: NativeReleaseCertificationRequirement;
  }>;
  format: 1;
  generatedAt: string;
  release: {
    appBuild: string;
    appId: string;
    artifactBytes: number;
    artifactSha256: string;
    buildNumber?: number;
    engine: "capacitor" | "expo";
    marketingVersion?: string;
    platform: "android" | "ios";
    releaseId: string;
    runtime: string;
    signed: true;
    versionCode?: number;
  };
  requirement: NativeReleaseCertificationRequirement;
  status: "certified";
  strength: NativeReleaseCertificationRequirement;
};

export type NativeReleaseCertificationProvenance = {
  issuer: string;
  subject: string;
  verifiedAt: string;
  verificationId: string;
};

export type NativeReleaseCertificationVerification = {
  bundle: Record<string, unknown>;
  format: 1;
  identity: {
    issuer: string;
    ref: string;
    repository: string;
    sha: string;
    workflowPath: string;
  };
  kind: "sigstore-bundle";
};

export type NativeReleaseCertificationReceipt = {
  certificationId: string;
  releaseId: string;
  requirement: NativeReleaseCertificationRequirement;
  strength: NativeReleaseCertificationRequirement;
  provenance?: NativeReleaseCertificationProvenance;
};

export type NativeReleaseRecord = {
  artifactKey: string;
  format: typeof NATIVE_RELEASE_REGISTRY_FORMAT;
  metadata: NativeReleaseMetadata;
};

export type NativeReleaseChannel = {
  appId: string;
  channel: string;
  format: typeof NATIVE_RELEASE_REGISTRY_FORMAT;
  platform: NativeReleaseMetadata["platform"];
  promotedAt: string;
  releaseId: string;
  sha256: string;
  certification?: NativeReleaseCertificationReceipt;
};

export type NativeReleaseBlobObject = {
  key: string;
  lastModified?: number;
  metadata?: Record<string, string>;
  size: number;
};

export type NativeReleaseBlobStore = {
  delete?: (key: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  head: (key: string) => Promise<NativeReleaseBlobObject | null>;
  list?: (options?: {
    cursor?: string;
    limit?: number;
    prefix?: string;
  }) => Promise<{
    cursor?: string;
    objects: NativeReleaseBlobObject[];
    truncated: boolean;
  }>;
  put: (
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: {
      cacheControl?: string;
      contentType?: string;
      maxBytes?: number;
      metadata?: Record<string, string>;
      signal?: AbortSignal;
    },
  ) => Promise<unknown>;
};

export type NativeReleasePublication = {
  certification?: NativeReleaseCertificationReceipt;
  channel?: NativeReleaseChannel;
  record: NativeReleaseRecord;
  reused: boolean;
};

export type NativeReleaseRegistry = {
  promote: (options: {
    allowUnsigned?: boolean;
    appId: string;
    channel: string;
    platform: NativeReleaseMetadata["platform"];
    releaseId: string;
    certificationId?: string;
    certificationRequirement?: NativeReleaseCertificationRequirement;
    signal?: AbortSignal;
  }) => Promise<NativeReleaseChannel>;
  publish: (options: {
    allowUnsigned?: boolean;
    channel?: string;
    certification?: NativeReleaseCertification;
    certificationRequirement?: NativeReleaseCertificationRequirement;
    certificationVerification?: NativeReleaseCertificationVerification;
    releaseRoot: string;
    signal?: AbortSignal;
  }) => Promise<NativeReleasePublication>;
  read: (options: {
    appId: string;
    platform: NativeReleaseMetadata["platform"];
    releaseId: string;
  }) => Promise<NativeReleaseRecord | null>;
  resolve: (options: {
    appId: string;
    channel: string;
    platform: NativeReleaseMetadata["platform"];
  }) => Promise<{
    channel: NativeReleaseChannel;
    record: NativeReleaseRecord;
  } | null>;
};

export type NativeReleaseRegistryOptions = {
  certificationVerifier?: (options: {
    certification: NativeReleaseCertification;
    metadata: NativeReleaseMetadata;
    requirement: NativeReleaseCertificationRequirement;
    signal?: AbortSignal;
    verification?: NativeReleaseCertificationVerification;
  }) => Promise<NativeReleaseCertificationProvenance>;
  clock?: () => Date;
  maxArtifactBytes?: number;
  prefix?: string;
  requireTrustedCertification?: boolean;
  store: NativeReleaseBlobStore;
};

export class NativeReleaseRegistryError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0)
    throw new NativeReleaseRegistryError(`Native release ${field} is invalid`);

  return value;
};

const parseCertificationVerification = (
  value: NativeReleaseCertificationVerification,
): NativeReleaseCertificationVerification => {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    value.kind !== "sigstore-bundle" ||
    !isRecord(value.identity) ||
    !isRecord(value.bundle)
  )
    throw new NativeReleaseRegistryError(
      "Native release certification verification is invalid",
    );
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new NativeReleaseRegistryError(
      "Native release certification verification is invalid",
    );
  }
  if (
    !encoded ||
    new TextEncoder().encode(encoded).byteLength >
      MAX_CERTIFICATION_VERIFICATION_BYTES
  )
    throw new NativeReleaseRegistryError(
      "Native release certification verification exceeds the configured limit",
    );

  return {
    bundle: value.bundle,
    format: 1,
    identity: {
      issuer: requireString(value.identity.issuer, "verification issuer"),
      ref: requireString(value.identity.ref, "verification ref"),
      repository: requireString(
        value.identity.repository,
        "verification repository",
      ),
      sha: requireString(value.identity.sha, "verification sha"),
      workflowPath: requireString(
        value.identity.workflowPath,
        "verification workflowPath",
      ),
    },
    kind: "sigstore-bundle",
  };
};

const parseMetadata = (value: unknown): NativeReleaseMetadata => {
  if (!isRecord(value))
    throw new NativeReleaseRegistryError("Native release metadata is invalid");
  const appId = requireString(value.appId, "appId");
  const sha256 = requireString(value.sha256, "sha256");
  const releaseId = requireString(value.releaseId, "releaseId");
  if (!APP_ID_PATTERN.test(appId))
    throw new NativeReleaseRegistryError("Native release appId is invalid");
  if (!SHA256_PATTERN.test(sha256))
    throw new NativeReleaseRegistryError("Native release sha256 is invalid");
  if (value.platform !== "android" && value.platform !== "ios")
    throw new NativeReleaseRegistryError("Native release metadata is invalid");
  if (releaseId !== `amobile_${value.platform}_${sha256}`)
    throw new NativeReleaseRegistryError(
      "Native release id does not match its artifact digest",
    );
  const commonInvalid =
    (value.engine !== "capacitor" && value.engine !== "expo") ||
    value.format !== 1 ||
    typeof value.signed !== "boolean" ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1;
  if (commonInvalid)
    throw new NativeReleaseRegistryError("Native release metadata is invalid");
  const engine = value.engine as "capacitor" | "expo";
  if (value.platform === "android") {
    if (
      value.artifact !== "app-release.aab" ||
      value.type !== "aab" ||
      (value.versionCode !== undefined &&
        (!Number.isSafeInteger(value.versionCode) ||
          Number(value.versionCode) < 1 ||
          Number(value.versionCode) > 2_100_000_000))
    )
      throw new NativeReleaseRegistryError(
        "Native release metadata is invalid",
      );

    return {
      appBuild: requireString(value.appBuild, "appBuild"),
      appId,
      artifact: "app-release.aab",
      bytes: Number(value.bytes),
      engine,
      format: 1,
      platform: "android",
      releaseId,
      runtime: requireString(value.runtime, "runtime"),
      sha256,
      signed: value.signed === true,
      type: "aab",
      ...(value.versionCode === undefined
        ? {}
        : { versionCode: Number(value.versionCode) }),
    };
  }
  if (
    value.artifact !== "App.ipa" ||
    value.type !== "ipa" ||
    typeof value.marketingVersion !== "string" ||
    !/^\d+(?:\.\d+){0,2}$/.test(value.marketingVersion) ||
    (value.buildNumber !== undefined &&
      (!Number.isSafeInteger(value.buildNumber) ||
        Number(value.buildNumber) < 1))
  )
    throw new NativeReleaseRegistryError("Native release metadata is invalid");

  return {
    appBuild: requireString(value.appBuild, "appBuild"),
    appId,
    artifact: "App.ipa",
    ...(value.buildNumber === undefined
      ? {}
      : { buildNumber: Number(value.buildNumber) }),
    bytes: Number(value.bytes),
    engine,
    format: 1,
    marketingVersion: value.marketingVersion,
    platform: "ios",
    releaseId,
    runtime: requireString(value.runtime, "runtime"),
    sha256,
    signed: value.signed === true,
    type: "ipa",
  };
};

const normalizedPrefix = (value: string) => {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (
    prefix.length === 0 ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new NativeReleaseRegistryError("Native release prefix is invalid");

  return prefix;
};

const requireChannel = (value: string) => {
  if (!CHANNEL_PATTERN.test(value))
    throw new NativeReleaseRegistryError("Native release channel is invalid");

  return value;
};

const appIdentity = (appId: string) =>
  createHash("sha256").update(appId).digest("hex");

const sha256Bytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    return false;

  return new Date(value).toISOString() === value;
};

const certificationRank: Record<NativeReleaseCertificationRequirement, number> =
  {
    installed: 0,
    simulator: 1,
    device: 2,
    store: 3,
  };

const isCertificationRequirement = (
  value: unknown,
): value is NativeReleaseCertificationRequirement =>
  value === "installed" ||
  value === "simulator" ||
  value === "device" ||
  value === "store";

const certificationSatisfies = (
  platform: NativeReleaseMetadata["platform"],
  strength: NativeReleaseCertificationRequirement,
  requirement: NativeReleaseCertificationRequirement,
) => {
  if (platform === "android")
    return strength === "installed" && requirement === "installed";
  if (strength === "installed" || requirement === "installed") return false;

  return certificationRank[strength] >= certificationRank[requirement];
};

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    sorted[key] = canonicalJsonValue(value[key]);

  return sorted;
};

const certificationBody = (
  certification: Omit<NativeReleaseCertification, "certificationId">,
) => JSON.stringify(canonicalJsonValue(certification));

const expectedCertificationRelease = (metadata: NativeReleaseMetadata) => ({
  appBuild: metadata.appBuild,
  appId: metadata.appId,
  artifactBytes: metadata.bytes,
  artifactSha256: metadata.sha256,
  ...(metadata.platform === "ios" && metadata.buildNumber !== undefined
    ? { buildNumber: metadata.buildNumber }
    : {}),
  engine: metadata.engine,
  ...(metadata.platform === "ios"
    ? { marketingVersion: metadata.marketingVersion }
    : {}),
  platform: metadata.platform,
  releaseId: metadata.releaseId,
  runtime: metadata.runtime,
  signed: true as const,
  ...(metadata.platform === "android" && metadata.versionCode !== undefined
    ? { versionCode: metadata.versionCode }
    : {}),
});

const parseCertification = (
  value: unknown,
  metadata: NativeReleaseMetadata,
): NativeReleaseCertification => {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    value.status !== "certified" ||
    !CERTIFICATION_ID_PATTERN.test(String(value.certificationId)) ||
    !isIsoTimestamp(value.generatedAt) ||
    !isCertificationRequirement(value.requirement) ||
    !isCertificationRequirement(value.strength) ||
    !isRecord(value.release) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    !certificationSatisfies(
      metadata.platform,
      value.strength,
      value.requirement,
    )
  )
    throw new NativeReleaseRegistryError(
      "Native release certification is invalid",
    );
  const expectedRelease = expectedCertificationRelease(metadata);
  if (
    JSON.stringify(canonicalJsonValue(value.release)) !==
    JSON.stringify(canonicalJsonValue(expectedRelease))
  )
    throw new NativeReleaseRegistryError(
      "Native release certification does not match the immutable release identity",
    );
  const evidence = value.evidence.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !isIsoTimestamp(candidate.generatedAt) ||
      !SHA256_PATTERN.test(String(candidate.reportSha256)) ||
      !isCertificationRequirement(candidate.strength) ||
      (candidate.networkUnavailable !== "not-proven" &&
        candidate.networkUnavailable !== "proven") ||
      typeof candidate.remote !== "boolean" ||
      (candidate.artifactExactness !== undefined &&
        candidate.artifactExactness !== "archive-equivalent" &&
        candidate.artifactExactness !== "source-equivalent" &&
        candidate.artifactExactness !== "store-delivered") ||
      (candidate.distribution !== undefined &&
        candidate.distribution !== "apple-processed" &&
        candidate.distribution !== "registered-device" &&
        candidate.distribution !== "simulator-release")
    )
      throw new NativeReleaseRegistryError(
        "Native release certification evidence is invalid",
      );

    return {
      ...(candidate.artifactExactness === undefined
        ? {}
        : {
            artifactExactness: candidate.artifactExactness as NonNullable<
              NativeReleaseCertification["evidence"][number]["artifactExactness"]
            >,
          }),
      ...(candidate.distribution === undefined
        ? {}
        : {
            distribution: candidate.distribution as NonNullable<
              NativeReleaseCertification["evidence"][number]["distribution"]
            >,
          }),
      generatedAt: candidate.generatedAt,
      networkUnavailable: candidate.networkUnavailable as
        | "not-proven"
        | "proven",
      remote: candidate.remote,
      reportSha256: String(candidate.reportSha256),
      strength: candidate.strength,
    };
  });
  for (const item of evidence) {
    const validAndroid =
      metadata.platform === "android" &&
      item.strength === "installed" &&
      item.networkUnavailable === "proven" &&
      item.artifactExactness === undefined &&
      item.distribution === undefined &&
      item.remote === false;
    const validIosSimulator =
      metadata.platform === "ios" &&
      item.strength === "simulator" &&
      item.networkUnavailable === "not-proven" &&
      item.artifactExactness === "source-equivalent" &&
      item.distribution === "simulator-release";
    const validIosDevice =
      metadata.platform === "ios" &&
      item.strength === "device" &&
      item.networkUnavailable === "proven" &&
      item.artifactExactness === "archive-equivalent" &&
      item.distribution === "registered-device";
    const validIosStore =
      metadata.platform === "ios" &&
      item.strength === "store" &&
      item.networkUnavailable === "proven" &&
      item.artifactExactness === "store-delivered" &&
      item.distribution === "apple-processed";
    if (
      !validAndroid &&
      !validIosSimulator &&
      !validIosDevice &&
      !validIosStore
    )
      throw new NativeReleaseRegistryError(
        "Native release certification evidence semantics are invalid",
      );
  }
  const strongest = evidence.reduce(
    (current, item) =>
      certificationRank[item.strength] > certificationRank[current]
        ? item.strength
        : current,
    evidence[0]!.strength,
  );
  if (strongest !== value.strength)
    throw new NativeReleaseRegistryError(
      "Native release certification strength does not match its evidence",
    );
  const certification: NativeReleaseCertification = {
    certificationId: String(value.certificationId),
    evidence,
    format: 1,
    generatedAt: value.generatedAt,
    release: expectedRelease,
    requirement: value.requirement,
    status: "certified",
    strength: value.strength,
  };
  const { certificationId, ...body } = certification;
  if (
    certificationId !==
    `amobile_cert_${createHash("sha256").update(certificationBody(body)).digest("hex")}`
  )
    throw new NativeReleaseRegistryError(
      "Native release certification content digest is invalid",
    );

  return certification;
};

const parseCertificationProvenance = (
  value: unknown,
): NativeReleaseCertificationProvenance => {
  if (
    !isRecord(value) ||
    !isIsoTimestamp(value.verifiedAt) ||
    typeof value.issuer !== "string" ||
    value.issuer.length === 0 ||
    typeof value.subject !== "string" ||
    value.subject.length === 0 ||
    typeof value.verificationId !== "string" ||
    value.verificationId.length === 0
  )
    throw new NativeReleaseRegistryError(
      "Native release certification provenance is invalid",
    );

  return {
    issuer: value.issuer,
    subject: value.subject,
    verifiedAt: value.verifiedAt,
    verificationId: value.verificationId,
  };
};

const sha256File = async (file: Bun.BunFile) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);

  return hasher.digest("hex");
};

const encodedJson = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const decodedJson = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as unknown;

const sameMetadata = (
  left: NativeReleaseMetadata,
  right: NativeReleaseMetadata,
) => JSON.stringify(left) === JSON.stringify(right);

const parseRecord = (value: unknown): NativeReleaseRecord => {
  if (
    !isRecord(value) ||
    value.format !== NATIVE_RELEASE_REGISTRY_FORMAT ||
    typeof value.artifactKey !== "string"
  )
    throw new NativeReleaseRegistryError("Native release record is invalid");
  const metadata = parseMetadata(value.metadata);

  return {
    artifactKey: value.artifactKey,
    format: NATIVE_RELEASE_REGISTRY_FORMAT,
    metadata,
  };
};

const parseCertificationReceipt = (
  value: unknown,
): NativeReleaseCertificationReceipt => {
  if (
    !isRecord(value) ||
    !CERTIFICATION_ID_PATTERN.test(String(value.certificationId)) ||
    typeof value.releaseId !== "string" ||
    !isCertificationRequirement(value.requirement) ||
    !isCertificationRequirement(value.strength)
  )
    throw new NativeReleaseRegistryError(
      "Native release certification receipt is invalid",
    );

  return {
    certificationId: String(value.certificationId),
    releaseId: value.releaseId,
    requirement: value.requirement,
    strength: value.strength,
    ...(value.provenance === undefined
      ? {}
      : { provenance: parseCertificationProvenance(value.provenance) }),
  };
};

const parseChannel = (value: unknown): NativeReleaseChannel => {
  if (
    !isRecord(value) ||
    value.format !== NATIVE_RELEASE_REGISTRY_FORMAT ||
    (value.platform !== "android" && value.platform !== "ios") ||
    !isIsoTimestamp(value.promotedAt)
  )
    throw new NativeReleaseRegistryError("Native release channel is invalid");
  const appId = requireString(value.appId, "channel appId");
  const channel = requireChannel(requireString(value.channel, "channel"));
  const sha256 = requireString(value.sha256, "channel sha256");
  const releaseId = requireString(value.releaseId, "channel releaseId");
  if (!APP_ID_PATTERN.test(appId) || !SHA256_PATTERN.test(sha256))
    throw new NativeReleaseRegistryError("Native release channel is invalid");
  if (releaseId !== `amobile_${value.platform}_${sha256}`)
    throw new NativeReleaseRegistryError(
      "Native release channel identity does not match",
    );
  const certification =
    value.certification === undefined
      ? undefined
      : parseCertificationReceipt(value.certification);
  if (certification && certification.releaseId !== releaseId)
    throw new NativeReleaseRegistryError(
      "Native release channel certification identity does not match",
    );

  return {
    appId,
    channel,
    format: NATIVE_RELEASE_REGISTRY_FORMAT,
    platform: value.platform,
    promotedAt: value.promotedAt,
    releaseId,
    sha256,
    ...(certification ? { certification } : {}),
  };
};

export const createNativeReleaseRegistry = (
  options: NativeReleaseRegistryOptions,
): NativeReleaseRegistry => {
  const prefix = normalizedPrefix(options.prefix ?? DEFAULT_PREFIX);
  const maxArtifactBytes =
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1)
    throw new NativeReleaseRegistryError(
      "Native release maxArtifactBytes is invalid",
    );
  const clock = options.clock ?? (() => new Date());
  const appRoot = (
    appId: string,
    platform: NativeReleaseMetadata["platform"],
  ) => `${prefix}/${appIdentity(appId)}/${platform}`;
  const releaseRoot = (metadata: NativeReleaseMetadata) =>
    `${appRoot(metadata.appId, metadata.platform)}/releases/${metadata.releaseId}`;
  const recordKey = (metadata: NativeReleaseMetadata) =>
    `${releaseRoot(metadata)}/release.json`;
  const artifactKey = (metadata: NativeReleaseMetadata) =>
    `${releaseRoot(metadata)}/${metadata.artifact}`;
  const certificationKey = (
    metadata: NativeReleaseMetadata,
    certificationId: string,
  ) => `${releaseRoot(metadata)}/certifications/${certificationId}.json`;
  const channelKey = (
    appId: string,
    platform: NativeReleaseMetadata["platform"],
    channel: string,
  ) => `${appRoot(appId, platform)}/channels/${requireChannel(channel)}.json`;

  const requireStoredArtifact = async (
    key: string,
    metadata: NativeReleaseMetadata,
  ) => {
    const stored = await options.store.head(key);
    if (
      !stored ||
      stored.size !== metadata.bytes ||
      stored.metadata?.sha256 !== metadata.sha256 ||
      stored.metadata?.releaseId !== metadata.releaseId
    )
      throw new NativeReleaseRegistryError(
        "Stored native release artifact does not match its immutable identity",
      );
  };

  const readStoredCertification = async (
    metadata: NativeReleaseMetadata,
    certificationId: string,
  ) => {
    if (!CERTIFICATION_ID_PATTERN.test(certificationId))
      throw new NativeReleaseRegistryError(
        "Native release certification id is invalid",
      );
    const key = certificationKey(metadata, certificationId);
    const bytes = await options.store.get(key);
    if (!bytes) return null;
    const stored = await options.store.head(key);
    if (
      !stored ||
      stored.size !== bytes.byteLength ||
      stored.metadata?.certificationId !== certificationId ||
      stored.metadata?.releaseId !== metadata.releaseId ||
      stored.metadata?.sha256 !== sha256Bytes(bytes)
    )
      throw new NativeReleaseRegistryError(
        "Stored native release certification does not match its immutable identity",
      );
    const decoded = decodedJson(bytes);
    if (!isRecord(decoded) || decoded.format !== 1)
      throw new NativeReleaseRegistryError(
        "Stored native release certification is invalid",
      );
    const certification = parseCertification(decoded.certification, metadata);
    if (certification.certificationId !== certificationId)
      throw new NativeReleaseRegistryError(
        "Stored native release certification identity does not match",
      );

    return {
      certification,
      ...(decoded.provenance === undefined
        ? {}
        : { provenance: parseCertificationProvenance(decoded.provenance) }),
    };
  };

  const retainCertification = async (
    metadata: NativeReleaseMetadata,
    value: NativeReleaseCertification,
    requirement: NativeReleaseCertificationRequirement,
    verification?: NativeReleaseCertificationVerification,
    signal?: AbortSignal,
  ): Promise<NativeReleaseCertificationReceipt> => {
    const certification = parseCertification(value, metadata);
    if (
      !certificationSatisfies(
        metadata.platform,
        certification.strength,
        requirement,
      )
    )
      throw new NativeReleaseRegistryError(
        `Native release certification does not satisfy required ${requirement} policy`,
      );
    const existing = await readStoredCertification(
      metadata,
      certification.certificationId,
    );
    let provenance = existing?.provenance;
    if (existing) {
      if (
        JSON.stringify(existing.certification) !== JSON.stringify(certification)
      )
        throw new NativeReleaseRegistryError(
          "Published native release certification is immutable",
        );
      if (options.requireTrustedCertification && !provenance)
        throw new NativeReleaseRegistryError(
          "Native release registry requires trusted certification provenance",
        );
    } else {
      if (options.requireTrustedCertification && !options.certificationVerifier)
        throw new NativeReleaseRegistryError(
          "Native release registry requires a trusted certification verifier",
        );
      if (options.requireTrustedCertification && !verification)
        throw new NativeReleaseRegistryError(
          "Native release registry requires portable certification verification",
        );
      provenance = options.certificationVerifier
        ? parseCertificationProvenance(
            await options.certificationVerifier({
              certification,
              metadata,
              requirement,
              signal,
              ...(verification ? { verification } : {}),
            }),
          )
        : undefined;
      if (provenance && provenance.subject !== metadata.releaseId)
        throw new NativeReleaseRegistryError(
          "Native release certification provenance subject does not match",
        );
      const storedCertification = {
        certification,
        format: 1 as const,
        ...(provenance ? { provenance } : {}),
      };
      const serialized = encodedJson(storedCertification);
      const key = certificationKey(metadata, certification.certificationId);
      await options.store.put(key, serialized, {
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "application/json",
        maxBytes: serialized.byteLength,
        metadata: {
          certificationId: certification.certificationId,
          releaseId: metadata.releaseId,
          sha256: sha256Bytes(serialized),
        },
        signal,
      });
      const verified = await readStoredCertification(
        metadata,
        certification.certificationId,
      );
      if (!verified)
        throw new NativeReleaseRegistryError(
          "Native release certification retention verification failed",
        );
    }

    return {
      certificationId: certification.certificationId,
      releaseId: metadata.releaseId,
      requirement,
      strength: certification.strength,
      ...(provenance ? { provenance } : {}),
    };
  };

  const read = async (input: {
    appId: string;
    platform: NativeReleaseMetadata["platform"];
    releaseId: string;
  }) => {
    if (!APP_ID_PATTERN.test(input.appId))
      throw new NativeReleaseRegistryError("Native release appId is invalid");
    const digest = input.releaseId.replace(
      new RegExp(`^amobile_${input.platform}_`),
      "",
    );
    if (
      !SHA256_PATTERN.test(digest) ||
      input.releaseId !== `amobile_${input.platform}_${digest}`
    )
      throw new NativeReleaseRegistryError("Native release id is invalid");
    const identity: NativeReleaseMetadata =
      input.platform === "android"
        ? {
            appBuild: "lookup",
            appId: input.appId,
            artifact: "app-release.aab",
            bytes: 1,
            engine: "capacitor",
            format: 1,
            platform: "android",
            releaseId: input.releaseId,
            runtime: "lookup",
            sha256: digest,
            signed: true,
            type: "aab",
          }
        : {
            appBuild: "lookup",
            appId: input.appId,
            artifact: "App.ipa",
            bytes: 1,
            engine: "capacitor",
            format: 1,
            marketingVersion: "1.0.0",
            platform: "ios",
            releaseId: input.releaseId,
            runtime: "lookup",
            sha256: digest,
            signed: true,
            type: "ipa",
          };
    const key = recordKey(identity);
    const bytes = await options.store.get(key);
    if (!bytes) return null;
    const storedRecord = await options.store.head(key);
    if (
      !storedRecord ||
      storedRecord.size !== bytes.byteLength ||
      storedRecord.metadata?.releaseId !== input.releaseId ||
      storedRecord.metadata?.sha256 !== sha256Bytes(bytes)
    )
      throw new NativeReleaseRegistryError(
        "Stored native release record does not match its immutable identity",
      );
    const record = parseRecord(decodedJson(bytes));
    if (
      record.metadata.appId !== input.appId ||
      record.metadata.platform !== input.platform ||
      record.metadata.releaseId !== input.releaseId ||
      record.artifactKey !== artifactKey(record.metadata)
    )
      throw new NativeReleaseRegistryError(
        "Stored native release record identity does not match",
      );
    await requireStoredArtifact(record.artifactKey, record.metadata);

    return record;
  };

  const promote: NativeReleaseRegistry["promote"] = async (input) => {
    input.signal?.throwIfAborted();
    const record = await read(input);
    if (!record)
      throw new NativeReleaseRegistryError("Native release was not published");
    if (!record.metadata.signed && !input.allowUnsigned)
      throw new NativeReleaseRegistryError(
        "Unsigned native releases cannot be promoted",
      );
    if (
      (input.certificationId === undefined) !==
      (input.certificationRequirement === undefined)
    )
      throw new NativeReleaseRegistryError(
        "Native release promotion certification contract is incomplete",
      );
    if (
      options.requireTrustedCertification &&
      (!input.certificationId || !input.certificationRequirement)
    )
      throw new NativeReleaseRegistryError(
        "Native release registry requires trusted certification for promotion",
      );
    let certification: NativeReleaseCertificationReceipt | undefined;
    if (input.certificationId && input.certificationRequirement) {
      const stored = await readStoredCertification(
        record.metadata,
        input.certificationId,
      );
      if (!stored)
        throw new NativeReleaseRegistryError(
          "Native release certification was not retained",
        );
      if (
        !certificationSatisfies(
          record.metadata.platform,
          stored.certification.strength,
          input.certificationRequirement,
        )
      )
        throw new NativeReleaseRegistryError(
          `Native release certification does not satisfy required ${input.certificationRequirement} policy`,
        );
      if (options.requireTrustedCertification && !stored.provenance)
        throw new NativeReleaseRegistryError(
          "Native release registry requires trusted certification provenance",
        );
      certification = {
        certificationId: stored.certification.certificationId,
        releaseId: record.metadata.releaseId,
        requirement: input.certificationRequirement,
        strength: stored.certification.strength,
        ...(stored.provenance ? { provenance: stored.provenance } : {}),
      };
    }
    const key = channelKey(input.appId, input.platform, input.channel);
    const existingBytes = await options.store.get(key);
    if (existingBytes) {
      const existing = parseChannel(decodedJson(existingBytes));
      if (
        existing.appId !== input.appId ||
        existing.platform !== input.platform ||
        existing.channel !== input.channel
      )
        throw new NativeReleaseRegistryError(
          "Stored native release channel identity does not match",
        );
      if (existing.certification && !certification)
        throw new NativeReleaseRegistryError(
          "Certified native release channels cannot be downgraded",
        );
      if (
        existing.releaseId === input.releaseId &&
        JSON.stringify(existing.certification) === JSON.stringify(certification)
      )
        return existing;
    }
    const channel: NativeReleaseChannel = {
      appId: input.appId,
      channel: requireChannel(input.channel),
      format: NATIVE_RELEASE_REGISTRY_FORMAT,
      platform: input.platform,
      promotedAt: clock().toISOString(),
      releaseId: record.metadata.releaseId,
      sha256: record.metadata.sha256,
      ...(certification ? { certification } : {}),
    };
    const serialized = encodedJson(channel);
    await options.store.put(key, serialized, {
      cacheControl: "no-cache",
      contentType: "application/json",
      maxBytes: serialized.byteLength,
      metadata: {
        channel: channel.channel,
        releaseId: channel.releaseId,
        sha256: channel.sha256,
      },
      signal: input.signal,
    });
    const stored = await options.store.get(key);
    if (
      !stored ||
      JSON.stringify(parseChannel(decodedJson(stored))) !==
        JSON.stringify(channel)
    )
      throw new NativeReleaseRegistryError(
        "Native release channel verification failed",
      );

    return channel;
  };

  return {
    promote,
    publish: async (input) => {
      input.signal?.throwIfAborted();
      const localRoot = path.resolve(input.releaseRoot);
      const metadata = parseMetadata(
        JSON.parse(
          await readFile(path.join(localRoot, "release.json"), "utf8"),
        ),
      );
      if (metadata.bytes > maxArtifactBytes)
        throw new NativeReleaseRegistryError(
          "Native release exceeds the configured artifact limit",
        );
      if (!metadata.signed && !input.allowUnsigned)
        throw new NativeReleaseRegistryError(
          "Unsigned native releases cannot be published",
        );
      const localArtifact = path.join(localRoot, metadata.artifact);
      const artifactStats = await stat(localArtifact).catch(() => null);
      if (!artifactStats?.isFile() || artifactStats.size !== metadata.bytes)
        throw new NativeReleaseRegistryError(
          "Native release artifact size does not match its metadata",
        );
      if ((await sha256File(Bun.file(localArtifact))) !== metadata.sha256)
        throw new NativeReleaseRegistryError(
          "Native release artifact digest does not match its metadata",
        );
      if (input.certificationRequirement && !input.certification)
        throw new NativeReleaseRegistryError(
          `Native release publication requires ${input.certificationRequirement} certification`,
        );
      if (input.certificationVerification && !input.certification)
        throw new NativeReleaseRegistryError(
          "Native release certification verification requires certification",
        );
      const certificationVerification = input.certificationVerification
        ? parseCertificationVerification(input.certificationVerification)
        : undefined;
      const certificationRequirement =
        input.certificationRequirement ?? input.certification?.requirement;
      const requestedCertification = input.certification
        ? parseCertification(input.certification, metadata)
        : undefined;
      if (
        requestedCertification &&
        certificationRequirement &&
        !certificationSatisfies(
          metadata.platform,
          requestedCertification.strength,
          certificationRequirement,
        )
      )
        throw new NativeReleaseRegistryError(
          `Native release certification does not satisfy required ${certificationRequirement} policy`,
        );
      const existing = await read({
        appId: metadata.appId,
        platform: metadata.platform,
        releaseId: metadata.releaseId,
      });
      let record: NativeReleaseRecord;
      let reused = false;
      if (existing) {
        if (!sameMetadata(existing.metadata, metadata))
          throw new NativeReleaseRegistryError(
            "Published native release metadata is immutable",
          );
        record = existing;
        reused = true;
      } else {
        const key = artifactKey(metadata);
        const storedArtifact = await options.store.head(key);
        if (storedArtifact) {
          await requireStoredArtifact(key, metadata);
        } else {
          await options.store.put(key, Bun.file(localArtifact).stream(), {
            cacheControl: "public, max-age=31536000, immutable",
            contentType: "application/octet-stream",
            maxBytes: metadata.bytes,
            metadata: {
              appId: metadata.appId,
              releaseId: metadata.releaseId,
              sha256: metadata.sha256,
            },
            signal: input.signal,
          });
          await requireStoredArtifact(key, metadata);
        }
        record = {
          artifactKey: key,
          format: NATIVE_RELEASE_REGISTRY_FORMAT,
          metadata,
        };
        const serialized = encodedJson(record);
        await options.store.put(recordKey(metadata), serialized, {
          cacheControl: "public, max-age=31536000, immutable",
          contentType: "application/json",
          maxBytes: serialized.byteLength,
          metadata: {
            releaseId: metadata.releaseId,
            sha256: sha256Bytes(serialized),
          },
          signal: input.signal,
        });
        const verified = await read({
          appId: metadata.appId,
          platform: metadata.platform,
          releaseId: metadata.releaseId,
        });
        if (!verified || JSON.stringify(verified) !== JSON.stringify(record))
          throw new NativeReleaseRegistryError(
            "Native release publication verification failed",
          );
      }
      const certification =
        requestedCertification && certificationRequirement
          ? await retainCertification(
              metadata,
              requestedCertification,
              certificationRequirement,
              certificationVerification,
              input.signal,
            )
          : undefined;
      const channel = input.channel
        ? await promote({
            allowUnsigned: input.allowUnsigned,
            appId: metadata.appId,
            channel: input.channel,
            platform: metadata.platform,
            releaseId: metadata.releaseId,
            ...(certification
              ? {
                  certificationId: certification.certificationId,
                  certificationRequirement: certification.requirement,
                }
              : {}),
            signal: input.signal,
          })
        : undefined;

      return {
        ...(channel ? { channel } : {}),
        ...(certification ? { certification } : {}),
        record,
        reused,
      };
    },
    read,
    resolve: async (input) => {
      if (!APP_ID_PATTERN.test(input.appId))
        throw new NativeReleaseRegistryError("Native release appId is invalid");
      const key = channelKey(input.appId, input.platform, input.channel);
      const bytes = await options.store.get(key);
      if (!bytes) return null;
      const channel = parseChannel(decodedJson(bytes));
      if (
        channel.appId !== input.appId ||
        channel.platform !== input.platform ||
        channel.channel !== input.channel
      )
        throw new NativeReleaseRegistryError(
          "Stored native release channel identity does not match",
        );
      const record = await read({
        appId: channel.appId,
        platform: channel.platform,
        releaseId: channel.releaseId,
      });
      if (!record || record.metadata.sha256 !== channel.sha256)
        throw new NativeReleaseRegistryError(
          "Native release channel points to a missing or invalid release",
        );
      if (channel.certification) {
        const stored = await readStoredCertification(
          record.metadata,
          channel.certification.certificationId,
        );
        if (
          !stored ||
          stored.certification.strength !== channel.certification.strength ||
          !certificationSatisfies(
            record.metadata.platform,
            stored.certification.strength,
            channel.certification.requirement,
          ) ||
          JSON.stringify(stored.provenance) !==
            JSON.stringify(channel.certification.provenance)
        )
          throw new NativeReleaseRegistryError(
            "Native release channel certification is missing or invalid",
          );
      }

      return { channel, record };
    },
  };
};
