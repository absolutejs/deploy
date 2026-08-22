import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PREFIX = "absolutejs/native-releases";
const DEFAULT_MAX_ARTIFACT_BYTES = 2_147_483_648;
export const NATIVE_RELEASE_REGISTRY_FORMAT = 1 as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APP_ID_PATTERN = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type AndroidNativeReleaseMetadata = {
  appBuild: string;
  appId: string;
  artifact: "app-release.aab";
  bytes: number;
  engine: "capacitor";
  format: 1;
  platform: "android";
  releaseId: string;
  runtime: string;
  sha256: string;
  signed: boolean;
  type: "aab";
};

export type NativeReleaseMetadata = AndroidNativeReleaseMetadata;

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
};

export type NativeReleaseBlobObject = {
  key: string;
  metadata?: Record<string, string>;
  size: number;
};

export type NativeReleaseBlobStore = {
  get: (key: string) => Promise<Uint8Array | null>;
  head: (key: string) => Promise<NativeReleaseBlobObject | null>;
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
    signal?: AbortSignal;
  }) => Promise<NativeReleaseChannel>;
  publish: (options: {
    allowUnsigned?: boolean;
    channel?: string;
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
  clock?: () => Date;
  maxArtifactBytes?: number;
  prefix?: string;
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
  if (releaseId !== `amobile_android_${sha256}`)
    throw new NativeReleaseRegistryError(
      "Native release id does not match its artifact digest",
    );
  if (
    value.artifact !== "app-release.aab" ||
    value.engine !== "capacitor" ||
    value.format !== 1 ||
    value.platform !== "android" ||
    value.type !== "aab" ||
    typeof value.signed !== "boolean" ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1
  )
    throw new NativeReleaseRegistryError("Native release metadata is invalid");

  return {
    appBuild: requireString(value.appBuild, "appBuild"),
    appId,
    artifact: "app-release.aab",
    bytes: Number(value.bytes),
    engine: "capacitor",
    format: 1,
    platform: "android",
    releaseId,
    runtime: requireString(value.runtime, "runtime"),
    sha256,
    signed: value.signed,
    type: "aab",
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

const parseChannel = (value: unknown): NativeReleaseChannel => {
  if (
    !isRecord(value) ||
    value.format !== NATIVE_RELEASE_REGISTRY_FORMAT ||
    value.platform !== "android" ||
    !isIsoTimestamp(value.promotedAt)
  )
    throw new NativeReleaseRegistryError("Native release channel is invalid");
  const appId = requireString(value.appId, "channel appId");
  const channel = requireChannel(requireString(value.channel, "channel"));
  const sha256 = requireString(value.sha256, "channel sha256");
  const releaseId = requireString(value.releaseId, "channel releaseId");
  if (!APP_ID_PATTERN.test(appId) || !SHA256_PATTERN.test(sha256))
    throw new NativeReleaseRegistryError("Native release channel is invalid");
  if (releaseId !== `amobile_android_${sha256}`)
    throw new NativeReleaseRegistryError(
      "Native release channel identity does not match",
    );

  return {
    appId,
    channel,
    format: NATIVE_RELEASE_REGISTRY_FORMAT,
    platform: "android",
    promotedAt: value.promotedAt,
    releaseId,
    sha256,
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
  const appRoot = (appId: string, platform: "android") =>
    `${prefix}/${appIdentity(appId)}/${platform}`;
  const releaseRoot = (metadata: NativeReleaseMetadata) =>
    `${appRoot(metadata.appId, metadata.platform)}/releases/${metadata.releaseId}`;
  const recordKey = (metadata: NativeReleaseMetadata) =>
    `${releaseRoot(metadata)}/release.json`;
  const artifactKey = (metadata: NativeReleaseMetadata) =>
    `${releaseRoot(metadata)}/${metadata.artifact}`;
  const channelKey = (appId: string, platform: "android", channel: string) =>
    `${appRoot(appId, platform)}/channels/${requireChannel(channel)}.json`;

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

  const read = async (input: {
    appId: string;
    platform: "android";
    releaseId: string;
  }) => {
    if (!APP_ID_PATTERN.test(input.appId))
      throw new NativeReleaseRegistryError("Native release appId is invalid");
    const digest = input.releaseId.replace(/^amobile_android_/, "");
    if (
      !SHA256_PATTERN.test(digest) ||
      input.releaseId !== `amobile_android_${digest}`
    )
      throw new NativeReleaseRegistryError("Native release id is invalid");
    const identity: NativeReleaseMetadata = {
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
      if (existing.releaseId === input.releaseId) return existing;
    }
    const channel: NativeReleaseChannel = {
      appId: input.appId,
      channel: requireChannel(input.channel),
      format: NATIVE_RELEASE_REGISTRY_FORMAT,
      platform: input.platform,
      promotedAt: clock().toISOString(),
      releaseId: record.metadata.releaseId,
      sha256: record.metadata.sha256,
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
      const channel = input.channel
        ? await promote({
            allowUnsigned: input.allowUnsigned,
            appId: metadata.appId,
            channel: input.channel,
            platform: metadata.platform,
            releaseId: metadata.releaseId,
            signal: input.signal,
          })
        : undefined;

      return { ...(channel ? { channel } : {}), record, reused };
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

      return { channel, record };
    },
  };
};
