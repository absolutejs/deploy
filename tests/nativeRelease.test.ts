import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createNativeReleaseRegistry,
  NativeReleaseRegistryError,
  type AndroidNativeReleaseMetadata,
  type IosNativeReleaseMetadata,
  type NativeReleaseBlobStore,
} from "../src/nativeRelease";

const roots: string[] = [];

const temporaryRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "absolute-native-release-"));
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const collectBody = async (
  body: ReadableStream<Uint8Array> | Uint8Array | string,
) => {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;

  return new Uint8Array(await new Response(body).arrayBuffer());
};

type MemoryObject = {
  bytes: Uint8Array;
  metadata?: Record<string, string>;
};

const memoryStore = () => {
  const objects = new Map<string, MemoryObject>();
  const puts: string[] = [];
  const store: NativeReleaseBlobStore = {
    get: async (key) => objects.get(key)?.bytes ?? null,
    head: async (key) => {
      const object = objects.get(key);

      return object
        ? { key, metadata: object.metadata, size: object.bytes.byteLength }
        : null;
    },
    put: async (key, body, options) => {
      const bytes = await collectBody(body);
      if (
        options?.maxBytes !== undefined &&
        bytes.byteLength > options.maxBytes
      )
        throw new Error("too large");
      puts.push(key);
      objects.set(key, { bytes, metadata: options?.metadata });
    },
  };

  return { objects, puts, store };
};

const releaseFixture = async (label: string, signed = true) => {
  const releaseRoot = await temporaryRoot();
  const artifact = new TextEncoder().encode(`android-aab-${label}`);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const metadata: AndroidNativeReleaseMetadata = {
    appBuild: `app-build-${label}`,
    appId: "com.example.absolute",
    artifact: "app-release.aab",
    bytes: artifact.byteLength,
    engine: "capacitor",
    format: 1,
    platform: "android",
    releaseId: `amobile_android_${sha256}`,
    runtime: `runtime-${label}`,
    sha256,
    signed,
    type: "aab",
  };
  await mkdir(releaseRoot, { recursive: true });
  await Bun.write(path.join(releaseRoot, metadata.artifact), artifact);
  await Bun.write(
    path.join(releaseRoot, "release.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  return { artifact, metadata, releaseRoot };
};

describe("native release registry", () => {
  test("publishes and resolves an immutable signed IPA", async () => {
    const memory = memoryStore();
    const releaseRoot = await temporaryRoot();
    const artifact = new TextEncoder().encode("ios-ipa");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    const metadata: IosNativeReleaseMetadata = {
      appBuild: "app-build-ios",
      appId: "com.example.absolute",
      artifact: "App.ipa",
      buildNumber: 9,
      bytes: artifact.byteLength,
      engine: "capacitor",
      format: 1,
      marketingVersion: "1.2.0",
      platform: "ios",
      releaseId: `amobile_ios_${sha256}`,
      runtime: "runtime-ios",
      sha256,
      signed: true,
      type: "ipa",
    };
    await Bun.write(path.join(releaseRoot, metadata.artifact), artifact);
    await Bun.write(
      path.join(releaseRoot, "release.json"),
      `${JSON.stringify(metadata)}\n`,
    );
    const registry = createNativeReleaseRegistry({ store: memory.store });
    const publication = await registry.publish({
      channel: "testflight",
      releaseRoot,
    });
    if (!publication.channel) throw new Error("expected TestFlight channel");
    expect(publication.record.metadata).toEqual(metadata);
    expect(
      await registry.resolve({
        appId: metadata.appId,
        channel: "testflight",
        platform: "ios",
      }),
    ).toEqual({ channel: publication.channel, record: publication.record });
  });

  test("publishes and resolves an immutable signed AAB through a BlobStore", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("one");
    const registry = createNativeReleaseRegistry({
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      store: memory.store,
    });
    const first = await registry.publish({
      channel: "internal",
      releaseRoot: fixture.releaseRoot,
    });
    const second = await registry.publish({
      channel: "internal",
      releaseRoot: fixture.releaseRoot,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.record.metadata).toEqual(fixture.metadata);
    expect(first.record.artifactKey).not.toContain(fixture.metadata.appId);
    expect(first.channel).toMatchObject({
      channel: "internal",
      promotedAt: "2026-08-22T12:00:00.000Z",
      releaseId: fixture.metadata.releaseId,
    });
    expect(
      memory.puts.filter((key) => key.endsWith("app-release.aab")),
    ).toHaveLength(1);
    expect(first.channel).toBeDefined();
    if (!first.channel) throw new Error("expected internal channel");
    expect(
      await registry.resolve({
        appId: fixture.metadata.appId,
        channel: "internal",
        platform: "android",
      }),
    ).toEqual({ channel: first.channel, record: first.record });
  });

  test("rejects changed local artifacts or stored release identities", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("tamper");
    const registry = createNativeReleaseRegistry({ store: memory.store });
    await Bun.write(
      path.join(fixture.releaseRoot, fixture.metadata.artifact),
      "changed",
    );
    await expect(
      registry.publish({ releaseRoot: fixture.releaseRoot }),
    ).rejects.toBeInstanceOf(NativeReleaseRegistryError);

    const valid = await releaseFixture("valid");
    const published = await registry.publish({
      releaseRoot: valid.releaseRoot,
    });
    const stored = memory.objects.get(published.record.artifactKey);
    expect(stored).toBeDefined();
    if (stored)
      stored.metadata = { ...stored.metadata, sha256: "0".repeat(64) };
    await expect(
      registry.read({
        appId: valid.metadata.appId,
        platform: "android",
        releaseId: valid.metadata.releaseId,
      }),
    ).rejects.toThrow("immutable identity");

    if (stored)
      stored.metadata = { ...stored.metadata, sha256: valid.metadata.sha256 };
    const storedRecord = [...memory.objects.entries()].find(([key]) =>
      key.endsWith("/release.json"),
    )?.[1];
    expect(storedRecord).toBeDefined();
    if (storedRecord)
      storedRecord.metadata = {
        ...storedRecord.metadata,
        sha256: "0".repeat(64),
      };
    await expect(
      registry.read({
        appId: valid.metadata.appId,
        platform: "android",
        releaseId: valid.metadata.releaseId,
      }),
    ).rejects.toThrow("record does not match its immutable identity");
  });

  test("fails closed for unsigned releases unless every operation opts in", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("unsigned", false);
    const registry = createNativeReleaseRegistry({ store: memory.store });
    await expect(
      registry.publish({ releaseRoot: fixture.releaseRoot }),
    ).rejects.toThrow("Unsigned native releases cannot be published");
    await registry.publish({
      allowUnsigned: true,
      releaseRoot: fixture.releaseRoot,
    });
    await expect(
      registry.promote({
        appId: fixture.metadata.appId,
        channel: "local-testing",
        platform: "android",
        releaseId: fixture.metadata.releaseId,
      }),
    ).rejects.toThrow("Unsigned native releases cannot be promoted");
    const channel = await registry.promote({
      allowUnsigned: true,
      appId: fixture.metadata.appId,
      channel: "local-testing",
      platform: "android",
      releaseId: fixture.metadata.releaseId,
    });
    expect(channel.channel).toBe("local-testing");
  });

  test("promotes and rolls channels back without copying artifact bytes", async () => {
    const memory = memoryStore();
    const first = await releaseFixture("first");
    const second = await releaseFixture("second");
    let minute = 0;
    const registry = createNativeReleaseRegistry({
      clock: () => new Date(Date.UTC(2026, 7, 22, 12, minute++)),
      store: memory.store,
    });
    await registry.publish({
      channel: "beta",
      releaseRoot: first.releaseRoot,
    });
    await registry.publish({ releaseRoot: second.releaseRoot });
    await registry.promote({
      appId: second.metadata.appId,
      channel: "beta",
      platform: "android",
      releaseId: second.metadata.releaseId,
    });
    await registry.promote({
      appId: first.metadata.appId,
      channel: "beta",
      platform: "android",
      releaseId: first.metadata.releaseId,
    });

    const resolved = await registry.resolve({
      appId: first.metadata.appId,
      channel: "beta",
      platform: "android",
    });
    expect(resolved?.record.metadata.releaseId).toBe(first.metadata.releaseId);
    expect(
      memory.puts.filter((key) => key.endsWith("app-release.aab")),
    ).toHaveLength(2);
  });

  test("rejects unsafe prefixes, channels, and release identities", async () => {
    const memory = memoryStore();
    expect(() =>
      createNativeReleaseRegistry({ prefix: "../escape", store: memory.store }),
    ).toThrow("prefix is invalid");
    const registry = createNativeReleaseRegistry({ store: memory.store });
    await expect(
      registry.resolve({
        appId: "com.example.absolute",
        channel: "../production",
        platform: "android",
      }),
    ).rejects.toThrow("channel is invalid");
    await expect(
      registry.read({
        appId: "com.example.absolute",
        platform: "android",
        releaseId: "../release",
      }),
    ).rejects.toThrow("release id is invalid");
  });
});
