import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { NativeReleaseBlobStore } from "./nativeRelease";

export const MOBILE_UPDATE_REGISTRY_FORMAT = 1 as const;
const DEFAULT_PREFIX = "absolutejs/mobile-updates";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^amu_[a-f0-9]{64}$/;
const APP_ID = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXPO_DESCRIPTOR = "_absolute/expo-update.json";

export type MobileUpdateFile = {
  bytes: number;
  path: string;
  sha256: string;
};

export type MobileUpdateManifest = {
  appId: string;
  channel: string;
  classification: "bug-fix" | "content" | "security";
  createdAt: string;
  files: MobileUpdateFile[];
  format: 1;
  releaseId: string;
  runtimeFingerprint: string;
  signature: {
    algorithm: "ecdsa-p256-sha256";
    keyId: string;
    value: string;
  };
  withinSubmittedPurpose: true;
};

export type MobileUpdateChannel = {
  appId: string;
  channel: string;
  fallbackReleaseId?: string;
  format: typeof MOBILE_UPDATE_REGISTRY_FORMAT;
  promotedAt: string;
  releaseId?: string;
  rollout: number;
};

export type MobileUpdatePublication = {
  appId: string;
  channel: string;
  releaseId: string;
  reused: boolean;
  rollout: number;
  stage: "published";
};

export type MobileUpdatePromotion = {
  appId: string;
  channel: string;
  releaseId: string;
  rollout: number;
  stage: "promoted";
};

export type MobileUpdateRollback = {
  appId: string;
  channel: string;
  releaseId?: string;
  stage: "rolled-back";
};

export type MobileUpdateRegistry = {
  publishUpdate(input: {
    manifest: MobileUpdateManifest;
    releaseDirectory: string;
    rollout: number;
    signal?: AbortSignal;
  }): Promise<MobileUpdatePublication>;
  promoteUpdate(input: {
    appId: string;
    channel: string;
    releaseId: string;
    rollout: number;
    signal?: AbortSignal;
  }): Promise<MobileUpdatePromotion>;
  rollbackUpdate(input: {
    appId: string;
    channel: string;
    releaseId?: string;
    signal?: AbortSignal;
  }): Promise<MobileUpdateRollback>;
  resolveUpdate(input: {
    appId: string;
    channel: string;
    installationId: string;
    runtimeFingerprint: string;
  }): Promise<{ manifest: MobileUpdateManifest; manifestKey: string } | null>;
  readUpdateFile(input: {
    appId: string;
    path: string;
    releaseId: string;
  }): Promise<{ bytes: Uint8Array; file: MobileUpdateFile } | null>;
};

export type MobileUpdateRegistryOptions = {
  clock?: () => Date;
  prefix?: string;
  /** Trusted ECDSA P-256 SPKI public keys as canonical base64 DER. */
  publicKeys: Readonly<Record<string, string>>;
  store: NativeReleaseBlobStore;
};

export class MobileUpdateRegistryError extends Error {}

type ExpoUpdateAsset = { extension?: string; path: string };
type ExpoUpdateDescriptor = {
  engine: "expo";
  expoConfig: Record<string, unknown>;
  format: 1;
  platforms: Partial<
    Record<
      "android" | "ios",
      { assets: ExpoUpdateAsset[]; launchAsset: ExpoUpdateAsset }
    >
  >;
  runtimeVersion: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0)
    throw new MobileUpdateRegistryError(`Mobile update ${field} is invalid`);

  return value;
};

const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const safePath = (value: unknown) => {
  const file = text(value, "file path").replaceAll("\\", "/");
  if (
    file.startsWith("/") ||
    file
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new MobileUpdateRegistryError("Mobile update file path is invalid");

  return file;
};

const expoAsset = (value: unknown): ExpoUpdateAsset => {
  if (!object(value))
    throw new MobileUpdateRegistryError("Expo update asset is invalid");
  const assetPath = safePath(value.path);
  if (
    value.extension !== undefined &&
    (typeof value.extension !== "string" ||
      !/^[A-Za-z0-9]+$/.test(value.extension))
  )
    throw new MobileUpdateRegistryError(
      "Expo update asset extension is invalid",
    );

  return {
    ...(typeof value.extension === "string"
      ? { extension: value.extension }
      : {}),
    path: assetPath,
  };
};

const parseExpoUpdateDescriptor = (bytes: Uint8Array): ExpoUpdateDescriptor => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MobileUpdateRegistryError("Expo update descriptor is invalid");
  }
  if (
    !object(value) ||
    value.engine !== "expo" ||
    value.format !== 1 ||
    !object(value.expoConfig) ||
    !object(value.platforms) ||
    typeof value.runtimeVersion !== "string" ||
    !HASH.test(value.runtimeVersion)
  )
    throw new MobileUpdateRegistryError("Expo update descriptor is invalid");
  const platforms: ExpoUpdateDescriptor["platforms"] = {};
  for (const name of ["android", "ios"] as const) {
    const candidate = value.platforms[name];
    if (candidate === undefined) continue;
    if (
      !object(candidate) ||
      !Array.isArray(candidate.assets) ||
      !object(candidate.launchAsset)
    )
      throw new MobileUpdateRegistryError(
        "Expo update platform descriptor is invalid",
      );
    platforms[name] = {
      assets: candidate.assets.map(expoAsset),
      launchAsset: expoAsset(candidate.launchAsset),
    };
  }
  if (Object.keys(platforms).length === 0)
    throw new MobileUpdateRegistryError(
      "Expo update descriptor has no native platforms",
    );

  return {
    engine: "expo",
    expoConfig: value.expoConfig,
    format: 1,
    platforms,
    runtimeVersion: value.runtimeVersion,
  };
};

export const parseMobileUpdateManifest = (
  value: unknown,
): MobileUpdateManifest => {
  if (!object(value) || value.format !== 1)
    throw new MobileUpdateRegistryError("Mobile update manifest is invalid");
  const appId = text(value.appId, "appId");
  const channel = text(value.channel, "channel");
  const releaseId = text(value.releaseId, "releaseId");
  const runtimeFingerprint = text(value.runtimeFingerprint, "runtime");
  if (!APP_ID.test(appId) || !NAME.test(channel) || !RELEASE.test(releaseId))
    throw new MobileUpdateRegistryError("Mobile update identity is invalid");
  if (!HASH.test(runtimeFingerprint) || !iso(value.createdAt))
    throw new MobileUpdateRegistryError(
      "Mobile update runtime or timestamp is invalid",
    );
  if (
    value.classification !== "bug-fix" &&
    value.classification !== "content" &&
    value.classification !== "security"
  )
    throw new MobileUpdateRegistryError(
      "Mobile update classification is invalid",
    );
  if (value.withinSubmittedPurpose !== true)
    throw new MobileUpdateRegistryError(
      "Mobile update policy attestation is missing",
    );
  if (!Array.isArray(value.files) || value.files.length === 0)
    throw new MobileUpdateRegistryError(
      "Mobile update file inventory is invalid",
    );
  const files = value.files.map((candidate): MobileUpdateFile => {
    if (!object(candidate))
      throw new MobileUpdateRegistryError("Mobile update file is invalid");
    const filePath = safePath(candidate.path);
    if (
      !Number.isSafeInteger(candidate.bytes) ||
      Number(candidate.bytes) < 0 ||
      Number(candidate.bytes) > MAX_FILE_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !HASH.test(candidate.sha256)
    )
      throw new MobileUpdateRegistryError(
        `Mobile update file ${filePath} is invalid`,
      );

    return {
      bytes: Number(candidate.bytes),
      path: filePath,
      sha256: candidate.sha256,
    };
  });
  if (
    files.reduce((total, file) => total + file.bytes, 0) > MAX_TOTAL_BYTES ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) =>
      index > 0
        ? file.path.localeCompare(files[index - 1]?.path ?? "") <= 0
        : false,
    )
  )
    throw new MobileUpdateRegistryError(
      "Mobile update file inventory is invalid",
    );
  const signatureKeyId = object(value.signature)
    ? text(value.signature.keyId, "signature key")
    : "";
  const signatureValue = object(value.signature)
    ? text(value.signature.value, "signature")
    : "";
  if (
    !object(value.signature) ||
    value.signature.algorithm !== "ecdsa-p256-sha256" ||
    !NAME.test(signatureKeyId) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureValue) ||
    Buffer.from(signatureValue, "base64").byteLength !== 64 ||
    Buffer.from(signatureValue, "base64").toString("base64") !== signatureValue
  )
    throw new MobileUpdateRegistryError("Mobile update signature is invalid");

  return {
    appId,
    channel,
    classification: value.classification,
    createdAt: value.createdAt,
    files,
    format: 1,
    releaseId,
    runtimeFingerprint,
    signature: {
      algorithm: "ecdsa-p256-sha256",
      keyId: signatureKeyId,
      value: signatureValue,
    },
    withinSubmittedPurpose: true,
  };
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!object(value)) return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
};

const verifyManifestSignature = (
  manifest: MobileUpdateManifest,
  publicKeys: Readonly<Record<string, string>>,
) => {
  const encoded = publicKeys[manifest.signature.keyId];
  if (!encoded)
    throw new MobileUpdateRegistryError(
      "Mobile update signing key is not trusted",
    );
  let publicKey;
  try {
    const der = Buffer.from(encoded, "base64");
    if (der.toString("base64") !== encoded) throw new Error("invalid base64");
    publicKey = createPublicKey({ format: "der", key: der, type: "spki" });
  } catch {
    throw new MobileUpdateRegistryError(
      "Mobile update trusted public key is invalid",
    );
  }
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new MobileUpdateRegistryError(
      "Mobile update trusted public key must use ECDSA P-256",
    );
  const { signature: _signature, ...unsigned } = manifest;
  if (
    !verify(
      "sha256",
      new TextEncoder().encode(JSON.stringify(canonicalValue(unsigned))),
      { dsaEncoding: "ieee-p1363", key: publicKey },
      Buffer.from(manifest.signature.value, "base64"),
    )
  )
    throw new MobileUpdateRegistryError(
      "Mobile update signature verification failed",
    );
};

const parseChannel = (value: unknown): MobileUpdateChannel => {
  if (!object(value) || value.format !== MOBILE_UPDATE_REGISTRY_FORMAT)
    throw new MobileUpdateRegistryError("Mobile update channel is invalid");
  const appId = text(value.appId, "channel appId");
  const channel = text(value.channel, "channel");
  if (
    !APP_ID.test(appId) ||
    !NAME.test(channel) ||
    !iso(value.promotedAt) ||
    typeof value.rollout !== "number" ||
    value.rollout < 0 ||
    value.rollout > 1 ||
    (value.releaseId !== undefined &&
      (typeof value.releaseId !== "string" ||
        !RELEASE.test(value.releaseId))) ||
    (value.fallbackReleaseId !== undefined &&
      (typeof value.fallbackReleaseId !== "string" ||
        !RELEASE.test(value.fallbackReleaseId)))
  )
    throw new MobileUpdateRegistryError("Mobile update channel is invalid");

  return {
    appId,
    channel,
    ...(value.fallbackReleaseId
      ? { fallbackReleaseId: value.fallbackReleaseId }
      : {}),
    format: MOBILE_UPDATE_REGISTRY_FORMAT,
    promotedAt: value.promotedAt,
    ...(value.releaseId ? { releaseId: value.releaseId } : {}),
    rollout: value.rollout,
  };
};

const normalizedPrefix = (value: string) => {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (
    !prefix ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new MobileUpdateRegistryError("Mobile update prefix is invalid");

  return prefix;
};

const appHash = (appId: string) =>
  createHash("sha256").update(appId).digest("hex");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const decode = (value: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(value)) as unknown;
const fileDigest = async (file: Bun.BunFile) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);

  return hasher.digest("hex");
};

const rolloutMember = (input: {
  appId: string;
  channel: string;
  installationId: string;
  releaseId: string;
  rollout: number;
}) => {
  if (input.rollout === 0) return false;
  if (input.rollout === 1) return true;
  const value = createHash("sha256")
    .update(
      `${input.appId}\0${input.channel}\0${input.releaseId}\0${input.installationId}`,
    )
    .digest()
    .readUInt32BE(0);

  return value / 0x1_0000_0000 < input.rollout;
};

export const createMobileUpdateRegistry = (
  options: MobileUpdateRegistryOptions,
): MobileUpdateRegistry => {
  const prefix = normalizedPrefix(options.prefix ?? DEFAULT_PREFIX);
  const clock = options.clock ?? (() => new Date());
  const root = (appId: string) => `${prefix}/${appHash(appId)}`;
  const releaseRoot = (
    manifest: Pick<MobileUpdateManifest, "appId" | "releaseId">,
  ) => `${root(manifest.appId)}/releases/${manifest.releaseId}`;
  const manifestKey = (
    manifest: Pick<MobileUpdateManifest, "appId" | "releaseId">,
  ) => `${releaseRoot(manifest)}/update.json`;
  const fileKey = (
    manifest: Pick<MobileUpdateManifest, "appId" | "releaseId">,
    file: MobileUpdateFile,
  ) => `${releaseRoot(manifest)}/files/${file.path}`;
  const channelKey = (appId: string, channel: string) => {
    if (!APP_ID.test(appId) || !NAME.test(channel))
      throw new MobileUpdateRegistryError(
        "Mobile update channel identity is invalid",
      );

    return `${root(appId)}/channels/${channel}.json`;
  };
  const readManifest = async (appId: string, releaseId: string) => {
    const key = manifestKey({ appId, releaseId });
    const bytes = await options.store.get(key);
    if (!bytes) return null;
    const head = await options.store.head(key);
    if (
      !head ||
      head.size !== bytes.byteLength ||
      head.metadata?.sha256 !== digest(bytes)
    )
      throw new MobileUpdateRegistryError(
        "Stored mobile update manifest integrity failed",
      );
    const manifest = parseMobileUpdateManifest(decode(bytes));
    verifyManifestSignature(manifest, options.publicKeys);
    if (manifest.appId !== appId || manifest.releaseId !== releaseId)
      throw new MobileUpdateRegistryError(
        "Stored mobile update identity changed",
      );

    return { key, manifest };
  };
  const readChannel = async (appId: string, channel: string) => {
    const bytes = await options.store.get(channelKey(appId, channel));
    if (!bytes) return null;
    const value = parseChannel(decode(bytes));
    if (value.appId !== appId || value.channel !== channel)
      throw new MobileUpdateRegistryError(
        "Stored mobile update channel identity changed",
      );

    return value;
  };
  const writeChannel = async (
    input: Omit<MobileUpdateChannel, "format" | "promotedAt">,
    signal?: AbortSignal,
  ) => {
    const value: MobileUpdateChannel = {
      ...input,
      format: MOBILE_UPDATE_REGISTRY_FORMAT,
      promotedAt: clock().toISOString(),
    };
    const bytes = json(value);
    await options.store.put(channelKey(value.appId, value.channel), bytes, {
      cacheControl: "no-cache",
      contentType: "application/json",
      maxBytes: bytes.byteLength,
      metadata: {
        channel: value.channel,
        ...(value.releaseId ? { releaseId: value.releaseId } : {}),
        sha256: digest(bytes),
      },
      signal,
    });

    return value;
  };
  const promoteUpdate: MobileUpdateRegistry["promoteUpdate"] = async (
    input,
  ) => {
    input.signal?.throwIfAborted();
    if (input.rollout <= 0 || input.rollout > 1)
      throw new MobileUpdateRegistryError("Mobile update rollout is invalid");
    const release = await readManifest(input.appId, input.releaseId);
    if (!release || release.manifest.channel !== input.channel)
      throw new MobileUpdateRegistryError(
        "Mobile update was not published to this channel",
      );
    const existing = await readChannel(input.appId, input.channel);
    await writeChannel(
      {
        appId: input.appId,
        channel: input.channel,
        ...(existing?.releaseId && existing.releaseId !== input.releaseId
          ? { fallbackReleaseId: existing.releaseId }
          : existing?.fallbackReleaseId
            ? { fallbackReleaseId: existing.fallbackReleaseId }
            : {}),
        releaseId: input.releaseId,
        rollout: input.rollout,
      },
      input.signal,
    );

    return {
      appId: input.appId,
      channel: input.channel,
      releaseId: input.releaseId,
      rollout: input.rollout,
      stage: "promoted",
    };
  };

  return {
    publishUpdate: async (input) => {
      input.signal?.throwIfAborted();
      const manifest = parseMobileUpdateManifest(input.manifest);
      verifyManifestSignature(manifest, options.publicKeys);
      const localRoot = path.resolve(input.releaseDirectory);
      const localManifest = parseMobileUpdateManifest(
        JSON.parse(await readFile(path.join(localRoot, "update.json"), "utf8")),
      );
      if (JSON.stringify(localManifest) !== JSON.stringify(manifest))
        throw new MobileUpdateRegistryError(
          "Local mobile update manifest changed",
        );
      const existing = await readManifest(manifest.appId, manifest.releaseId);
      let reused = existing !== null;
      if (
        existing &&
        JSON.stringify(existing.manifest) !== JSON.stringify(manifest)
      )
        throw new MobileUpdateRegistryError(
          "Published mobile update is immutable",
        );
      if (!existing) {
        for (const file of manifest.files) {
          const local = path.join(localRoot, "files", file.path);
          const metadata = await stat(local).catch(() => null);
          if (!metadata?.isFile() || metadata.size !== file.bytes)
            throw new MobileUpdateRegistryError(
              `Mobile update file ${file.path} size changed`,
            );
          if ((await fileDigest(Bun.file(local))) !== file.sha256)
            throw new MobileUpdateRegistryError(
              `Mobile update file ${file.path} integrity failed`,
            );
          const key = fileKey(manifest, file);
          const stored = await options.store.head(key);
          if (!stored) {
            await options.store.put(key, Bun.file(local).stream(), {
              cacheControl: "public, max-age=31536000, immutable",
              contentType: "application/octet-stream",
              maxBytes: file.bytes,
              metadata: { releaseId: manifest.releaseId, sha256: file.sha256 },
              signal: input.signal,
            });
          } else if (
            stored.size !== file.bytes ||
            stored.metadata?.sha256 !== file.sha256 ||
            stored.metadata?.releaseId !== manifest.releaseId
          )
            throw new MobileUpdateRegistryError(
              "Stored mobile update file identity changed",
            );
        }
        const bytes = json(manifest);
        await options.store.put(manifestKey(manifest), bytes, {
          cacheControl: "public, max-age=31536000, immutable",
          contentType: "application/json",
          maxBytes: bytes.byteLength,
          metadata: { releaseId: manifest.releaseId, sha256: digest(bytes) },
          signal: input.signal,
        });
        if (!(await readManifest(manifest.appId, manifest.releaseId)))
          throw new MobileUpdateRegistryError(
            "Mobile update publication verification failed",
          );
        reused = false;
      }
      await promoteUpdate({
        appId: manifest.appId,
        channel: manifest.channel,
        releaseId: manifest.releaseId,
        rollout: input.rollout,
        signal: input.signal,
      });

      return {
        appId: manifest.appId,
        channel: manifest.channel,
        releaseId: manifest.releaseId,
        reused,
        rollout: input.rollout,
        stage: "published",
      };
    },
    promoteUpdate,
    rollbackUpdate: async (input) => {
      input.signal?.throwIfAborted();
      const existing = await readChannel(input.appId, input.channel);
      if (!existing)
        throw new MobileUpdateRegistryError(
          "Mobile update channel does not exist",
        );
      if (input.releaseId) {
        const release = await readManifest(input.appId, input.releaseId);
        if (!release || release.manifest.channel !== input.channel)
          throw new MobileUpdateRegistryError(
            "Mobile rollback release was not published",
          );
      }
      await writeChannel(
        {
          appId: input.appId,
          channel: input.channel,
          ...(existing.releaseId
            ? { fallbackReleaseId: existing.releaseId }
            : {}),
          ...(input.releaseId ? { releaseId: input.releaseId } : {}),
          rollout: input.releaseId ? 1 : 0,
        },
        input.signal,
      );

      return {
        appId: input.appId,
        channel: input.channel,
        ...(input.releaseId ? { releaseId: input.releaseId } : {}),
        stage: "rolled-back",
      };
    },
    resolveUpdate: async (input) => {
      const channel = await readChannel(input.appId, input.channel);
      if (!channel?.releaseId) return null;
      const selected = rolloutMember({
        appId: input.appId,
        channel: input.channel,
        installationId: input.installationId,
        releaseId: channel.releaseId,
        rollout: channel.rollout,
      })
        ? channel.releaseId
        : channel.fallbackReleaseId;
      if (!selected) return null;
      const release = await readManifest(input.appId, selected);
      if (
        !release ||
        release.manifest.runtimeFingerprint !== input.runtimeFingerprint
      )
        return null;

      return { manifest: release.manifest, manifestKey: release.key };
    },
    readUpdateFile: async (input) => {
      const release = await readManifest(input.appId, input.releaseId);
      if (!release) return null;
      const requested = safePath(input.path);
      const file = release.manifest.files.find(
        (candidate) => candidate.path === requested,
      );
      if (!file) return null;
      const key = fileKey(release.manifest, file);
      const [bytes, head] = await Promise.all([
        options.store.get(key),
        options.store.head(key),
      ]);
      if (!bytes || !head) return null;
      if (
        bytes.byteLength !== file.bytes ||
        head.size !== file.bytes ||
        head.metadata?.sha256 !== file.sha256 ||
        head.metadata?.releaseId !== release.manifest.releaseId ||
        digest(bytes) !== file.sha256
      )
        throw new MobileUpdateRegistryError(
          "Stored mobile update file integrity failed",
        );

      return { bytes, file };
    },
  };
};

const expoUpdateId = (releaseId: string) => {
  const hash = releaseId.slice("amu_".length, "amu_".length + 32);

  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};

const expoContentType = (extension: string | undefined, launch: boolean) => {
  if (launch) return "application/javascript";
  const normalized = extension?.toLowerCase();
  if (normalized === "png") return "image/png";
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "webp") return "image/webp";
  if (normalized === "gif") return "image/gif";
  if (normalized === "svg") return "image/svg+xml";
  if (normalized === "json") return "application/json";
  if (normalized === "ttf") return "font/ttf";
  if (normalized === "otf") return "font/otf";
  if (normalized === "woff") return "font/woff";
  if (normalized === "woff2") return "font/woff2";

  return "application/octet-stream";
};

const encodeUpdatePath = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");

const expoProtocolHeaders = {
  "cache-control": "private, max-age=0",
  "content-type": "application/expo+json",
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
};

const expoRollbackResponse = (request: Request) => {
  const current = request.headers.get("expo-current-update-id");
  const embedded = request.headers.get("expo-embedded-update-id");
  if (!current || current === embedded)
    return new Response(null, { status: 204 });
  const boundary = `absolutejs-${crypto.randomUUID()}`;
  const directive = JSON.stringify({
    parameters: { commitTime: new Date().toISOString() },
    type: "rollBackToEmbedded",
  });
  const body = [
    `--${boundary}`,
    'content-disposition: form-data; name="directive"',
    "content-type: application/json; charset=utf-8",
    "",
    directive,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return new Response(body, {
    headers: {
      ...expoProtocolHeaders,
      "content-type": `multipart/mixed; boundary=${boundary}`,
    },
  });
};

export const createMobileUpdateHandler = (options: {
  allowedOrigins?: readonly string[];
  appId: string;
  channel: string;
  registry: MobileUpdateRegistry;
  route?: string;
}) => {
  const route = (
    options.route ?? `/__absolute/mobile/updates/${options.channel}`
  ).replace(/^\/+|\/+$/g, "");
  const allowedOrigins = new Set(
    options.allowedOrigins ?? ["capacitor://localhost", "https://localhost"],
  );

  return async (request: Request) => {
    const origin = request.headers.get("origin");
    const cors: Record<string, string> =
      origin && allowedOrigins.has(origin)
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {};
    if (request.method === "OPTIONS") {
      if (!origin || !allowedOrigins.has(origin))
        return new Response(null, { status: 403 });

      return new Response(null, {
        headers: {
          ...cors,
          "access-control-allow-headers":
            "x-absolute-mobile-app,x-absolute-mobile-channel,x-absolute-mobile-installation,x-absolute-mobile-release,x-absolute-mobile-runtime",
          "access-control-allow-methods": "GET,OPTIONS",
          "access-control-max-age": "600",
        },
        status: 204,
      });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const pathname = new URL(request.url).pathname.replace(/^\/+/, "");
    const relative = pathname.startsWith(`${route}/`)
      ? pathname.slice(route.length + 1)
      : "";
    if (relative === "update.json") {
      const expoProtocolVersion = request.headers.get("expo-protocol-version");
      const expoProtocol = expoProtocolVersion !== null;
      if (expoProtocol && expoProtocolVersion !== "1")
        return Response.json(
          { error: `Unsupported Expo Updates protocol version: ${expoProtocolVersion}` },
          { status: 406 },
        );
      const appId = request.headers.get("x-absolute-mobile-app");
      const channel = request.headers.get("x-absolute-mobile-channel");
      const installationId = request.headers.get(
        "x-absolute-mobile-installation",
      );
      const runtimeFingerprint = expoProtocol
        ? request.headers.get("expo-runtime-version")
        : request.headers.get("x-absolute-mobile-runtime");
      if (
        appId !== options.appId ||
        channel !== options.channel ||
        !installationId ||
        !runtimeFingerprint
      )
        return new Response(null, { status: 400 });
      const selected = await options.registry.resolveUpdate({
        appId,
        channel,
        installationId,
        runtimeFingerprint,
      });
      if (expoProtocol) {
        if (request.headers.has("expo-expect-signature"))
          return Response.json(
            { error: "Expo end-to-end code signing is not configured." },
            { status: 400 },
          );
        if (!selected) return expoRollbackResponse(request);
        const platform = request.headers.get("expo-platform");
        if (platform !== "android" && platform !== "ios")
          return new Response(null, { status: 400 });
        const updateId = expoUpdateId(selected.manifest.releaseId);
        if (request.headers.get("expo-current-update-id") === updateId)
          return new Response(null, { status: 204 });
        const descriptorFile = await options.registry.readUpdateFile({
          appId,
          path: EXPO_DESCRIPTOR,
          releaseId: selected.manifest.releaseId,
        });
        if (!descriptorFile) return new Response(null, { status: 409 });
        const descriptor = parseExpoUpdateDescriptor(descriptorFile.bytes);
        const platformUpdate = descriptor.platforms[platform];
        if (!platformUpdate || descriptor.runtimeVersion !== runtimeFingerprint)
          return new Response(null, { status: 204 });
        const origin = new URL(request.url).origin;
        const releaseRoute = `${origin}/${route}/${selected.manifest.releaseId}/files`;
        const protocolAsset = (asset: ExpoUpdateAsset, launch = false) => {
          const file = selected.manifest.files.find(
            (candidate) => candidate.path === asset.path,
          );
          if (!file)
            throw new MobileUpdateRegistryError(
              `Expo update references missing signed asset ${asset.path}`,
            );

          return {
            contentType: expoContentType(asset.extension, launch),
            ...(asset.extension
              ? { fileExtension: `.${asset.extension}` }
              : {}),
            key: file.sha256,
            hash: Buffer.from(file.sha256, "hex").toString("base64url"),
            url: `${releaseRoute}/${encodeUpdatePath(asset.path)}`,
          };
        };
        return Response.json(
          {
            assets: platformUpdate.assets.map((asset) => protocolAsset(asset)),
            createdAt: selected.manifest.createdAt,
            extra: {
              absolutejs: {
                channel: selected.manifest.channel,
                releaseId: selected.manifest.releaseId,
              },
              expoClient: descriptor.expoConfig,
            },
            id: updateId,
            launchAsset: protocolAsset(platformUpdate.launchAsset, true),
            metadata: {
              channel: selected.manifest.channel,
              releaseId: selected.manifest.releaseId,
            },
            runtimeVersion: descriptor.runtimeVersion,
          },
          { headers: expoProtocolHeaders },
        );
      }
      if (!selected) return new Response(null, { status: 204 });

      return Response.json(selected.manifest, {
        headers: {
          ...cors,
          "cache-control": "no-store",
          etag: `"${selected.manifest.releaseId}"`,
        },
      });
    }
    const match = /^(amu_[a-f0-9]{64})\/files\/(.+)$/.exec(relative);
    if (!match?.[1] || !match[2]) return new Response(null, { status: 404 });
    const file = await options.registry.readUpdateFile({
      appId: options.appId,
      path: decodeURIComponent(match[2]),
      releaseId: match[1],
    });
    if (!file) return new Response(null, { status: 404 });

    return new Response(new Blob([new Uint8Array(file.bytes).buffer]), {
      headers: {
        ...cors,
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": String(file.file.bytes),
        "content-type": expoContentType(
          file.file.path.includes(".")
            ? file.file.path.slice(file.file.path.lastIndexOf(".") + 1)
            : undefined,
          false,
        ),
        etag: `"${file.file.sha256}"`,
      },
    });
  };
};
