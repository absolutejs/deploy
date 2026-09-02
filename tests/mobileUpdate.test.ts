import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createMobileUpdateHandler,
  createMobileUpdateRegistry,
  MobileUpdateRegistryError,
  type MobileUpdateManifest,
} from "../src/mobileUpdate";
import type { NativeReleaseBlobStore } from "../src/nativeRelease";

const roots: string[] = [];
const signingKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeys = {
  "key-1": signingKey.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64"),
};
const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
};
const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "absolute-mobile-update-"));
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const memoryStore = () => {
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata?: Record<string, string> }
  >();
  const store: NativeReleaseBlobStore = {
    get: async (key) => objects.get(key)?.bytes ?? null,
    head: async (key) => {
      const value = objects.get(key);

      return value
        ? { key, metadata: value.metadata, size: value.bytes.byteLength }
        : null;
    },
    put: async (key, body, options) => {
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, metadata: options?.metadata });
    },
  };

  return { objects, store };
};

const fixture = async (label: string) => {
  const root = await temporaryRoot();
  const contents = new TextEncoder().encode(`app-${label}`);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const releaseId = `amu_${createHash("sha256").update(label).digest("hex")}`;
  const unsigned: Omit<MobileUpdateManifest, "signature"> = {
    appId: "com.example.absolute",
    channel: "production",
    classification: "bug-fix",
    createdAt: "2026-09-01T12:00:00.000Z",
    files: [{ bytes: contents.byteLength, path: "index.html", sha256 }],
    format: 1,
    releaseId,
    runtimeFingerprint: "a".repeat(64),
    withinSubmittedPurpose: true,
  };
  const signature = sign(
    "sha256",
    new TextEncoder().encode(JSON.stringify(canonicalValue(unsigned))),
    { dsaEncoding: "ieee-p1363", key: signingKey.privateKey },
  );
  const manifest: MobileUpdateManifest = {
    ...unsigned,
    signature: {
      algorithm: "ecdsa-p256-sha256",
      keyId: "key-1",
      value: signature.toString("base64"),
    },
  };
  await Bun.write(path.join(root, "files/index.html"), contents);
  await Bun.write(path.join(root, "update.json"), JSON.stringify(manifest));

  return { manifest, root };
};

const expoFixture = async () => {
  const root = await temporaryRoot();
  const runtimeFingerprint = "c".repeat(64);
  const sources = new Map([
    ["_expo/static/js/ios/entry.hbc", new TextEncoder().encode("ios")],
    ["_expo/static/js/android/entry.hbc", new TextEncoder().encode("android")],
    ["assets/icon.png", new TextEncoder().encode("image")],
  ]);
  const descriptor = {
    engine: "expo",
    expoConfig: { name: "Absolute", slug: "absolute" },
    format: 1,
    platforms: {
      android: {
        assets: [{ extension: "png", path: "assets/icon.png" }],
        launchAsset: {
          extension: "hbc",
          path: "_expo/static/js/android/entry.hbc",
        },
      },
      ios: {
        assets: [{ extension: "png", path: "assets/icon.png" }],
        launchAsset: {
          extension: "hbc",
          path: "_expo/static/js/ios/entry.hbc",
        },
      },
    },
    runtimeVersion: runtimeFingerprint,
  };
  sources.set(
    "_absolute/expo-update.json",
    new TextEncoder().encode(JSON.stringify(descriptor)),
  );
  const files = [...sources].map(([filePath, contents]) => ({
    bytes: contents.byteLength,
    path: filePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
  }));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const releaseId = `amu_${createHash("sha256").update("expo").digest("hex")}`;
  const unsigned: Omit<MobileUpdateManifest, "signature"> = {
    appId: "com.example.absolute",
    channel: "production",
    classification: "bug-fix",
    createdAt: "2026-09-02T12:00:00.000Z",
    files,
    format: 1,
    releaseId,
    runtimeFingerprint,
    withinSubmittedPurpose: true,
  };
  const manifest: MobileUpdateManifest = {
    ...unsigned,
    signature: {
      algorithm: "ecdsa-p256-sha256",
      keyId: "key-1",
      value: sign(
        "sha256",
        new TextEncoder().encode(JSON.stringify(canonicalValue(unsigned))),
        { dsaEncoding: "ieee-p1363", key: signingKey.privateKey },
      ).toString("base64"),
    },
  };
  await Promise.all(
    [...sources].map(([filePath, contents]) =>
      Bun.write(path.join(root, "files", filePath), contents),
    ),
  );
  await Bun.write(path.join(root, "update.json"), JSON.stringify(manifest));

  return { manifest, root };
};

describe("mobile update registry", () => {
  test("publishes immutable files and resolves a stable staged cohort", async () => {
    const memory = memoryStore();
    const release = await fixture("one");
    const registry = createMobileUpdateRegistry({
      clock: () => new Date("2026-09-01T13:00:00.000Z"),
      publicKeys,
      store: memory.store,
    });
    const publication = await registry.publishUpdate({
      manifest: release.manifest,
      releaseDirectory: release.root,
      rollout: 0.5,
    });

    expect(publication).toMatchObject({
      releaseId: release.manifest.releaseId,
      rollout: 0.5,
      stage: "published",
    });
    expect(
      [...memory.objects.keys()].some((key) =>
        key.endsWith(`/${release.manifest.releaseId}/files/index.html`),
      ),
    ).toBe(true);
    const identities = Array.from(
      { length: 200 },
      (_, index) =>
        `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    const selected = await Promise.all(
      identities.map((installationId) =>
        registry.resolveUpdate({
          appId: release.manifest.appId,
          channel: release.manifest.channel,
          installationId,
          runtimeFingerprint: release.manifest.runtimeFingerprint,
        }),
      ),
    );
    expect(selected.some(Boolean)).toBe(true);
    expect(selected.some((value) => !value)).toBe(true);

    await registry.promoteUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      releaseId: release.manifest.releaseId,
      rollout: 1,
    });
    const handler = createMobileUpdateHandler({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      registry,
    });
    const updateResponse = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            "x-absolute-mobile-app": release.manifest.appId,
            "x-absolute-mobile-channel": release.manifest.channel,
            "x-absolute-mobile-installation":
              "11111111-1111-4111-8111-111111111111",
            "x-absolute-mobile-runtime": release.manifest.runtimeFingerprint,
          },
        },
      ),
    );
    expect(updateResponse.status).toBe(200);
    const preflight = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        { method: "OPTIONS", headers: { origin: "capacitor://localhost" } },
      ),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "capacitor://localhost",
    );
    const assetResponse = await handler(
      new Request(
        `https://api.example.com/__absolute/mobile/updates/production/${release.manifest.releaseId}/files/index.html`,
      ),
    );
    expect(await assetResponse.text()).toBe("app-one");
  });

  test("promotes, rolls back, and fails closed for incompatible runtimes", async () => {
    const memory = memoryStore();
    const first = await fixture("first");
    const second = await fixture("second");
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });
    await registry.publishUpdate({
      manifest: first.manifest,
      releaseDirectory: first.root,
      rollout: 1,
    });
    await registry.publishUpdate({
      manifest: second.manifest,
      releaseDirectory: second.root,
      rollout: 0.1,
    });
    await registry.promoteUpdate({
      appId: second.manifest.appId,
      channel: second.manifest.channel,
      releaseId: second.manifest.releaseId,
      rollout: 1,
    });
    expect(
      await registry.resolveUpdate({
        appId: second.manifest.appId,
        channel: second.manifest.channel,
        installationId: "11111111-1111-4111-8111-111111111111",
        runtimeFingerprint: "b".repeat(64),
      }),
    ).toBeNull();
    await registry.rollbackUpdate({
      appId: first.manifest.appId,
      channel: first.manifest.channel,
      releaseId: first.manifest.releaseId,
    });
    expect(
      (
        await registry.resolveUpdate({
          appId: first.manifest.appId,
          channel: first.manifest.channel,
          installationId: "11111111-1111-4111-8111-111111111111",
          runtimeFingerprint: first.manifest.runtimeFingerprint,
        })
      )?.manifest.releaseId,
    ).toBe(first.manifest.releaseId);
    await registry.rollbackUpdate({
      appId: first.manifest.appId,
      channel: first.manifest.channel,
    });
    expect(
      await registry.resolveUpdate({
        appId: first.manifest.appId,
        channel: first.manifest.channel,
        installationId: "11111111-1111-4111-8111-111111111111",
        runtimeFingerprint: first.manifest.runtimeFingerprint,
      }),
    ).toBeNull();
  });

  test("rejects local tampering before publishing", async () => {
    const memory = memoryStore();
    const release = await fixture("tampered");
    await Bun.write(path.join(release.root, "files/index.html"), "changed");
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });

    await expect(
      registry.publishUpdate({
        manifest: release.manifest,
        releaseDirectory: release.root,
        rollout: 0.05,
      }),
    ).rejects.toBeInstanceOf(MobileUpdateRegistryError);
  });

  test("rejects a modified signature before storage", async () => {
    const memory = memoryStore();
    const release = await fixture("bad-signature");
    release.manifest.signature.value = Buffer.alloc(64).toString("base64");
    await Bun.write(
      path.join(release.root, "update.json"),
      JSON.stringify(release.manifest),
    );
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });

    await expect(
      registry.publishUpdate({
        manifest: release.manifest,
        releaseDirectory: release.root,
        rollout: 0.05,
      }),
    ).rejects.toThrow("signature verification failed");
    expect(memory.objects.size).toBe(0);
  });

  test("serves signed Expo exports through protocol v1 with stable cohorts and rollback", async () => {
    const memory = memoryStore();
    const release = await expoFixture();
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });
    await registry.publishUpdate({
      manifest: release.manifest,
      releaseDirectory: release.root,
      rollout: 1,
    });
    const handler = createMobileUpdateHandler({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      registry,
    });
    const headers = {
      "expo-platform": "ios",
      "expo-protocol-version": "1",
      "expo-runtime-version": release.manifest.runtimeFingerprint,
      "x-absolute-mobile-app": release.manifest.appId,
      "x-absolute-mobile-channel": release.manifest.channel,
      "x-absolute-mobile-installation": "11111111-1111-4111-8111-111111111111",
    };
    const response = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        { headers },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    const manifest = await response.json();
    expect(manifest.runtimeVersion).toBe(release.manifest.runtimeFingerprint);
    expect(manifest.launchAsset.url).toContain(
      `${release.manifest.releaseId}/files/_expo/static/js/ios/entry.hbc`,
    );
    expect(manifest.assets[0].contentType).toBe("image/png");
    expect(manifest.assets[0].hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manifest.extra.absolutejs.releaseId).toBe(
      release.manifest.releaseId,
    );

    const unsupported = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        { headers: { ...headers, "expo-protocol-version": "2" } },
      ),
    );
    expect(unsupported.status).toBe(406);
    expect(await unsupported.json()).toEqual({
      error: "Unsupported Expo Updates protocol version: 2",
    });

    await registry.rollbackUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
    });
    const rollback = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            ...headers,
            "expo-current-update-id": manifest.id,
            "expo-embedded-update-id": "embedded-id",
          },
        },
      ),
    );
    expect(rollback.headers.get("content-type")).toContain("multipart/mixed");
    expect(await rollback.text()).toContain("rollBackToEmbedded");
  });
});
