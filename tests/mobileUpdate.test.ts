import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
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
import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from "@expo/code-signing-certificates";

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

const memoryStore = (settings: { lowercaseMetadata?: boolean } = {}) => {
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata?: Record<string, string> }
  >();
  const store: NativeReleaseBlobStore = {
    delete: async (key) => {
      objects.delete(key);
    },
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
      objects.set(key, {
        bytes,
        metadata:
          settings.lowercaseMetadata && options?.metadata
            ? Object.fromEntries(
                Object.entries(options.metadata).map(([name, value]) => [
                  name.toLowerCase(),
                  value,
                ]),
              )
            : options?.metadata,
      });
    },
    list: async (options = {}) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ""))
        .map(([key, value]) => ({
          key,
          metadata: value.metadata,
          size: value.bytes.byteLength,
        })),
      truncated: false,
    }),
  };

  return { objects, store };
};

const fixture = async (label: string, source = `app-${label}`) => {
  const root = await temporaryRoot();
  const contents = new TextEncoder().encode(source);
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
        key.endsWith(`/blobs/${release.manifest.files[0]!.sha256}`),
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
    expect(assetResponse.headers.get("accept-ranges")).toBe("bytes");
    const assetUrl = `https://api.example.com/__absolute/mobile/updates/production/${release.manifest.releaseId}/files/index.html`;
    const rangeResponse = await handler(
      new Request(assetUrl, {
        headers: {
          "if-range": `"${release.manifest.files[0]!.sha256}"`,
          range: "bytes=3-",
        },
      }),
    );
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("content-range")).toBe("bytes 3-6/7");
    expect(rangeResponse.headers.get("content-length")).toBe("4");
    expect(await rangeResponse.text()).toBe("-one");
    const staleRange = await handler(
      new Request(assetUrl, {
        headers: { "if-range": '"stale"', range: "bytes=3-" },
      }),
    );
    expect(staleRange.status).toBe(200);
    expect(await staleRange.text()).toBe("app-one");
    const unsatisfiable = await handler(
      new Request(assetUrl, { headers: { range: "bytes=7-" } }),
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */7");
  });

  test("stores identical content once across releases while preserving release URLs", async () => {
    const memory = memoryStore();
    const first = await fixture("shared-one", "shared application bytes");
    const second = await fixture("shared-two", "shared application bytes");
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });

    const firstPublication = await registry.publishUpdate({
      manifest: first.manifest,
      releaseDirectory: first.root,
      rollout: 1,
    });
    const secondPublication = await registry.publishUpdate({
      manifest: second.manifest,
      releaseDirectory: second.root,
      rollout: 1,
    });

    expect(firstPublication).toMatchObject({
      reusedBytes: 0,
      reusedFiles: 0,
      storedBytes: first.manifest.files[0]!.bytes,
      storedFiles: 1,
    });
    expect(secondPublication).toMatchObject({
      reusedBytes: second.manifest.files[0]!.bytes,
      reusedFiles: 1,
      storedBytes: 0,
      storedFiles: 0,
    });
    expect(
      [...memory.objects.keys()].filter((key) => key.includes("/blobs/")),
    ).toHaveLength(1);
    await expect(
      registry.readUpdateFile({
        appId: first.manifest.appId,
        path: "index.html",
        releaseId: first.manifest.releaseId,
      }),
    ).resolves.toMatchObject({ file: first.manifest.files[0] });
    await expect(
      registry.readUpdateFile({
        appId: second.manifest.appId,
        path: "index.html",
        releaseId: second.manifest.releaseId,
      }),
    ).resolves.toMatchObject({ file: second.manifest.files[0] });
  });

  test("continues serving legacy release-scoped file objects", async () => {
    const memory = memoryStore();
    const release = await fixture("legacy-object");
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });
    await registry.publishUpdate({
      manifest: release.manifest,
      releaseDirectory: release.root,
      rollout: 1,
    });
    const blobKey = [...memory.objects.keys()].find((key) =>
      key.includes("/blobs/"),
    )!;
    const blob = memory.objects.get(blobKey)!;
    const appRoot = blobKey.slice(0, blobKey.indexOf("/blobs/"));
    memory.objects.set(
      `${appRoot}/releases/${release.manifest.releaseId}/files/index.html`,
      {
        ...blob,
        metadata: {
          releaseid: release.manifest.releaseId,
          sha256: release.manifest.files[0]!.sha256,
        },
      },
    );
    memory.objects.delete(blobKey);

    await expect(
      registry.readUpdateFile({
        appId: release.manifest.appId,
        path: "index.html",
        releaseId: release.manifest.releaseId,
      }),
    ).resolves.toMatchObject({ file: release.manifest.files[0] });
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

  test("accounts for storage and sweeps only unreferenced releases after a grace period", async () => {
    const memory = memoryStore();
    const first = await fixture("retention-first");
    const second = await fixture("retention-second");
    const third = await fixture("retention-third");
    let now = new Date("2026-10-01T00:00:00.000Z");
    const registry = createMobileUpdateRegistry({
      clock: () => now,
      publicKeys,
      store: memory.store,
    });
    for (const release of [first, second, third])
      await registry.publishUpdate({
        manifest: release.manifest,
        releaseDirectory: release.root,
        rollout: 1,
      });

    const report = await registry.inspectUpdateStorage({
      appId: first.manifest.appId,
      minAgeMs: 0,
      retainRecent: 0,
    });
    expect(report.releaseCount).toBe(3);
    expect(report.channelCount).toBe(1);
    expect(report.contentBlobCount).toBe(3);
    expect(report.totalBytes).toBeGreaterThan(report.releaseBytes);
    expect(
      report.releases.find(
        (release) => release.releaseId === third.manifest.releaseId,
      )?.protectedBy,
    ).toContain("active");
    expect(
      report.releases.find(
        (release) => release.releaseId === second.manifest.releaseId,
      )?.protectedBy,
    ).toContain("fallback");
    expect(report.reclaimableBytes).toBeGreaterThan(0);

    const preview = await registry.pruneUpdates({
      appId: first.manifest.appId,
      minAgeMs: 0,
      retainRecent: 0,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.marked).toEqual([]);
    expect([...memory.objects.keys()].some((key) => key.includes("/gc/"))).toBe(
      false,
    );

    const marked = await registry.pruneUpdates({
      appId: first.manifest.appId,
      apply: true,
      gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
      minAgeMs: 0,
      retainRecent: 0,
    });
    expect(marked.marked).toEqual([first.manifest.releaseId]);
    expect(marked.swept).toEqual([]);
    await expect(
      registry.promoteUpdate({
        appId: first.manifest.appId,
        channel: first.manifest.channel,
        releaseId: first.manifest.releaseId,
        rollout: 1,
      }),
    ).rejects.toThrow("marked for collection");

    now = new Date("2026-10-09T00:00:00.000Z");
    const swept = await registry.pruneUpdates({
      appId: first.manifest.appId,
      apply: true,
      gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
      minAgeMs: 0,
      retainRecent: 0,
    });
    expect(swept.swept).toEqual([first.manifest.releaseId]);
    expect(swept.sweptContentBlobs).toEqual([first.manifest.files[0]!.sha256]);
    expect(swept.reclaimedBytes).toBeGreaterThan(0);
    expect(
      await registry.readUpdateFile({
        appId: first.manifest.appId,
        path: "index.html",
        releaseId: first.manifest.releaseId,
      }),
    ).toBeNull();
    expect(
      await registry.readUpdateFile({
        appId: second.manifest.appId,
        path: "index.html",
        releaseId: second.manifest.releaseId,
      }),
    ).not.toBeNull();
  });

  test("restores a marked release when a later retention policy protects it", async () => {
    const memory = memoryStore();
    const first = await fixture("restore-first");
    const second = await fixture("restore-second");
    const third = await fixture("restore-third");
    const registry = createMobileUpdateRegistry({
      clock: () => new Date("2026-10-01T00:00:00.000Z"),
      publicKeys,
      store: memory.store,
    });
    for (const release of [first, second, third])
      await registry.publishUpdate({
        manifest: release.manifest,
        releaseDirectory: release.root,
        rollout: 1,
      });
    await registry.pruneUpdates({
      appId: first.manifest.appId,
      apply: true,
      minAgeMs: 0,
      retainRecent: 0,
    });
    const restored = await registry.pruneUpdates({
      appId: first.manifest.appId,
      apply: true,
      minAgeMs: 0,
      retainRecent: 3,
    });
    expect(restored.restored).toEqual([first.manifest.releaseId]);
    await expect(
      registry.promoteUpdate({
        appId: first.manifest.appId,
        channel: first.manifest.channel,
        releaseId: first.manifest.releaseId,
        rollout: 1,
      }),
    ).resolves.toMatchObject({ releaseId: first.manifest.releaseId });
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

  test("uses S3-compatible lowercase metadata for immutable files", async () => {
    const memory = memoryStore({ lowercaseMetadata: true });
    const release = await fixture("lowercase-metadata");
    const registry = createMobileUpdateRegistry({
      publicKeys,
      store: memory.store,
    });
    await registry.publishUpdate({
      manifest: release.manifest,
      releaseDirectory: release.root,
      rollout: 1,
    });

    expect(
      await registry.readUpdateFile({
        appId: release.manifest.appId,
        path: "index.html",
        releaseId: release.manifest.releaseId,
      }),
    ).not.toBeNull();
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
    const expoKeyPair = generateKeyPair();
    const expoCertificate = convertCertificateToCertificatePEM(
      generateSelfSignedCodeSigningCertificate({
        commonName: "AbsoluteJS Test Updates",
        keyPair: expoKeyPair,
        validityNotAfter: new Date("2036-01-01T00:00:00.000Z"),
        validityNotBefore: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const expoPrivateKey = convertKeyPairToPEM(expoKeyPair).privateKeyPEM;
    expect(() =>
      createMobileUpdateHandler({
        appId: release.manifest.appId,
        channel: release.manifest.channel,
        expoCodeSigning: {
          keys: {
            invalid: {
              certificate: expoCertificate,
              privateKey: signingKey.privateKey.export({
                format: "pem",
                type: "pkcs8",
              }),
            },
          },
        },
        registry,
      }),
    ).toThrow("self-signed RSA root and private key");
    const handler = createMobileUpdateHandler({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      expoCodeSigning: {
        keys: {
          "production-2025": {
            certificate: expoCertificate,
            privateKey: expoPrivateKey,
          },
          "production-2026": {
            certificate: expoCertificate,
            privateKey: expoPrivateKey,
          },
        },
      },
      registry,
    });
    const headers = {
      "expo-platform": "ios",
      "expo-protocol-version": "1",
      "expo-runtime-version": release.manifest.runtimeFingerprint,
      "expo-extra-params":
        'absolute-installation="11111111-1111-4111-8111-111111111111"',
      "x-absolute-mobile-app": release.manifest.appId,
      "x-absolute-mobile-channel": release.manifest.channel,
    };
    const signedHeaders = {
      ...headers,
      "expo-expect-signature":
        'sig, keyid="production-2026", alg="rsa-v1_5-sha256"',
    };
    const response = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        { headers: signedHeaders },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    const responseBody = await response.text();
    const manifest = JSON.parse(responseBody);
    const signatureHeader = response.headers.get("expo-signature");
    expect(signatureHeader).toContain('keyid="production-2026"');
    const signature = /sig="([A-Za-z0-9+/]+={0,2})"/u.exec(
      signatureHeader ?? "",
    )?.[1];
    expect(signature).toBeDefined();
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(responseBody),
        new X509Certificate(expoCertificate).publicKey,
        Buffer.from(signature!, "base64"),
      ),
    ).toBe(true);
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

    const unsupportedSigning = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            ...headers,
            "expo-expect-signature":
              'sig, keyid="wrong-key", alg="rsa-v1_5-sha256"',
          },
        },
      ),
    );
    expect(unsupportedSigning.status).toBe(406);
    const ambiguousSigning = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            ...headers,
            "expo-expect-signature": 'sig, alg="rsa-v1_5-sha256"',
          },
        },
      ),
    );
    expect(ambiguousSigning.status).toBe(406);

    const incompatible = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            ...signedHeaders,
            "expo-current-update-id": manifest.id,
            "expo-runtime-version": "f".repeat(64),
          },
        },
      ),
    );
    expect(incompatible.status).toBe(204);

    await registry.rollbackUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      releaseId: release.manifest.releaseId,
    });
    const republishedRollback = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            ...signedHeaders,
            "expo-current-update-id": manifest.id,
          },
        },
      ),
    );
    const republishedManifest = await republishedRollback.json();
    expect(republishedManifest.id).not.toBe(manifest.id);
    expect(republishedManifest.extra.absolutejs.releaseId).toBe(
      release.manifest.releaseId,
    );

    await registry.rollbackUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
    });
    const rollback = await handler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        {
          headers: {
            ...signedHeaders,
            "expo-current-update-id": manifest.id,
            "expo-embedded-update-id": "embedded-id",
          },
        },
      ),
    );
    expect(rollback.headers.get("content-type")).toContain("multipart/mixed");
    const rollbackBody = await rollback.text();
    expect(rollbackBody).toContain("rollBackToEmbedded");
    expect(rollbackBody).toContain('expo-signature: sig="');
    const rollbackDirective = /\r\n\r\n(\{[^\r]+\})\r\n--/u.exec(
      rollbackBody,
    )?.[1];
    const rollbackSignature =
      /expo-signature: sig="([A-Za-z0-9+/]+={0,2})"/u.exec(rollbackBody)?.[1];
    expect(rollbackDirective).toBeDefined();
    expect(rollbackSignature).toBeDefined();
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(rollbackDirective!),
        new X509Certificate(expoCertificate).publicKey,
        Buffer.from(rollbackSignature!, "base64"),
      ),
    ).toBe(true);

    const unsignedHandler = createMobileUpdateHandler({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      registry,
    });
    const missingServerKey = await unsignedHandler(
      new Request(
        "https://api.example.com/__absolute/mobile/updates/production/update.json",
        { headers: signedHeaders },
      ),
    );
    expect(missingServerKey.status).toBe(400);
  });

  test("records authenticated fleet health and pauses only one promotion generation", async () => {
    const memory = memoryStore();
    let now = new Date("2026-09-03T12:00:00.000Z");
    const first = await fixture("health-fallback");
    const release = await fixture("health-current");
    const registry = createMobileUpdateRegistry({
      clock: () => now,
      health: {
        autoPause: { failureRate: 0.5, minimumReports: 2 },
        secret: "health-secret-with-at-least-thirty-two-characters",
      },
      publicKeys,
      store: memory.store,
    });
    await registry.publishUpdate({
      manifest: first.manifest,
      releaseDirectory: first.root,
      rollout: 1,
    });
    now = new Date("2026-09-03T13:00:00.000Z");
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
    const identityHeaders = (installationId: string) => ({
      "x-absolute-mobile-app": release.manifest.appId,
      "x-absolute-mobile-channel": release.manifest.channel,
      "x-absolute-mobile-installation": installationId,
      "x-absolute-mobile-runtime": release.manifest.runtimeFingerprint,
    });
    const tokenFor = async (installationId: string) => {
      const response = await handler(
        new Request(
          "https://api.example.com/__absolute/mobile/updates/production/update.json",
          { headers: identityHeaders(installationId) },
        ),
      );
      expect(response.status).toBe(200);

      return response.headers.get("x-absolute-mobile-health-token")!;
    };
    const healthyId = "11111111-1111-4111-8111-111111111111";
    const failedId = "22222222-2222-4222-8222-222222222222";
    const healthyToken = await tokenFor(healthyId);
    const failedToken = await tokenFor(failedId);
    const report = (installationId: string, token: string, kind: string) =>
      handler(
        new Request(
          "https://api.example.com/__absolute/mobile/updates/production/health",
          {
            body: JSON.stringify({
              kind,
              releaseId: release.manifest.releaseId,
            }),
            headers: {
              ...identityHeaders(installationId),
              "content-type": "application/json",
              "x-absolute-mobile-health-token": token,
            },
            method: "POST",
          },
        ),
      );
    expect((await report(healthyId, healthyToken, "activated")).status).toBe(
      202,
    );
    const paused = await report(failedId, failedToken, "rolled-back");
    expect(paused.status).toBe(202);
    expect(await paused.json()).toEqual({ paused: true });
    expect((await report(failedId, failedToken, "rolled-back")).status).toBe(
      202,
    );
    expect(
      (await report(failedId, `${failedToken}x`, "rolled-back")).status,
    ).toBe(403);
    expect((await report(healthyId, failedToken, "rolled-back")).status).toBe(
      403,
    );
    await expect(
      registry.inspectUpdateHealth!({
        appId: release.manifest.appId,
        channel: release.manifest.channel,
      }),
    ).resolves.toMatchObject({
      activated: 1,
      failureRate: 0.5,
      failures: 1,
      paused: true,
      reportedInstallations: 2,
      rolledBack: 1,
      terminalReports: 2,
    });
    const afterPause = await registry.resolveUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      installationId: healthyId,
      runtimeFingerprint: release.manifest.runtimeFingerprint,
    });
    expect(afterPause?.manifest.releaseId).toBe(first.manifest.releaseId);
    expect(
      [...memory.objects.values()].some(({ bytes }) =>
        new TextDecoder().decode(bytes).includes(failedId),
      ),
    ).toBe(false);

    now = new Date("2026-09-03T14:00:00.000Z");
    await registry.promoteUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      releaseId: release.manifest.releaseId,
      rollout: 1,
    });
    const retry = await registry.resolveUpdate({
      appId: release.manifest.appId,
      channel: release.manifest.channel,
      installationId: healthyId,
      runtimeFingerprint: release.manifest.runtimeFingerprint,
    });
    expect(retry?.manifest.releaseId).toBe(release.manifest.releaseId);
  });
});
