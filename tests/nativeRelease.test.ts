import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createNativeReleaseRegistry,
  githubActionsArtifactProvenance,
  NativeReleaseRegistryError,
  type NativeReleaseArtifactProvenance,
  type AndroidNativeReleaseMetadata,
  type IosNativeReleaseMetadata,
  type NativeReleaseBlobStore,
  type NativeReleaseCertification,
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

const canonicalJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    sorted[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);

  return sorted;
};

const certificationFor = (
  metadata: AndroidNativeReleaseMetadata,
): NativeReleaseCertification => {
  const body: Omit<NativeReleaseCertification, "certificationId"> = {
    evidence: [
      {
        generatedAt: "2026-09-16T12:00:00.000Z",
        networkUnavailable: "proven",
        remote: false,
        reportSha256: "b".repeat(64),
        strength: "installed",
      },
    ],
    format: 1,
    generatedAt: "2026-09-16T12:00:00.000Z",
    release: {
      appBuild: metadata.appBuild,
      appId: metadata.appId,
      artifactBytes: metadata.bytes,
      artifactSha256: metadata.sha256,
      engine: metadata.engine,
      platform: "android",
      releaseId: metadata.releaseId,
      runtime: metadata.runtime,
      signed: true,
      ...(metadata.versionCode === undefined
        ? {}
        : { versionCode: metadata.versionCode }),
    },
    requirement: "installed",
    status: "certified",
    strength: "installed",
  };

  return {
    certificationId: `amobile_cert_${createHash("sha256")
      .update(JSON.stringify(canonicalJsonValue(body)))
      .digest("hex")}`,
    ...body,
  };
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
    if (!("artifactKey" in first.record))
      throw new Error("expected a stored release");
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

  test("retains certification and trusted provenance with the promoted release", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("certified");
    const certification = certificationFor(fixture.metadata);
    const certificationVerification = {
      bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" },
      format: 1,
      identity: {
        issuer: "https://token.actions.githubusercontent.com",
        ref: "refs/heads/main",
        repository: "absolutejs/example",
        sha: "a".repeat(40),
        workflowPath: ".github/workflows/absolute-mobile.yml",
      },
      kind: "sigstore-bundle",
    } as const;
    let verifications = 0;
    const registry = createNativeReleaseRegistry({
      certificationVerifier: async ({ metadata, requirement, verification }) => {
        verifications += 1;
        expect(requirement).toBe("installed");
        expect(verification).toEqual(certificationVerification);

        return {
          issuer: "absolutejs-paas",
          subject: metadata.releaseId,
          verifiedAt: "2026-09-16T12:05:00.000Z",
          verificationId: "verification-1",
        };
      },
      requireTrustedCertification: true,
      store: memory.store,
    });
    await expect(
      registry.publish({
        certificationRequirement: "installed",
        releaseRoot: fixture.releaseRoot,
      }),
    ).rejects.toThrow("requires installed certification");
    expect(memory.puts).toHaveLength(0);
    const first = await registry.publish({
      certification,
      certificationRequirement: "installed",
      certificationVerification,
      channel: "production",
      releaseRoot: fixture.releaseRoot,
    });
    const second = await registry.publish({
      certification,
      certificationRequirement: "installed",
      certificationVerification,
      channel: "production",
      releaseRoot: fixture.releaseRoot,
    });

    expect(verifications).toBe(1);
    expect(first.certification).toMatchObject({
      certificationId: certification.certificationId,
      releaseId: fixture.metadata.releaseId,
      requirement: "installed",
      strength: "installed",
      provenance: { issuer: "absolutejs-paas" },
    });
    expect(second.certification).toEqual(first.certification);
    expect(first.channel?.certification).toEqual(first.certification);
    if (!first.channel) throw new Error("expected certified channel");
    expect(
      memory.puts.filter((key) => key.includes("/certifications/")),
    ).toHaveLength(1);
    expect(
      await registry.resolve({
        appId: fixture.metadata.appId,
        channel: "production",
        platform: "android",
      }),
    ).toEqual({ channel: first.channel, record: first.record });
    await expect(
      registry.promote({
        appId: fixture.metadata.appId,
        channel: "uncertified",
        platform: "android",
        releaseId: fixture.metadata.releaseId,
      }),
    ).rejects.toThrow("requires trusted certification");
    await expect(
      registry.promote({
        appId: fixture.metadata.appId,
        channel: "production",
        platform: "android",
        releaseId: fixture.metadata.releaseId,
      }),
    ).rejects.toThrow("requires trusted certification");
  });

  test("requires bounded portable verification for trusted certification", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("portable-verification");
    const certification = certificationFor(fixture.metadata);
    const identity = {
      issuer: "https://token.actions.githubusercontent.com",
      ref: "refs/heads/main",
      repository: "absolutejs/example",
      sha: "a".repeat(40),
      workflowPath: ".github/workflows/absolute-mobile.yml",
    };
    const registry = createNativeReleaseRegistry({
      certificationVerifier: async ({ metadata }) => ({
        issuer: "https://token.actions.githubusercontent.com",
        subject: metadata.releaseId,
        verifiedAt: "2026-09-17T12:05:00.000Z",
        verificationId: "sigstore-verification-1",
      }),
      requireTrustedCertification: true,
      store: memory.store,
    });

    await expect(
      registry.publish({
        certification,
        certificationRequirement: "installed",
        releaseRoot: fixture.releaseRoot,
      }),
    ).rejects.toThrow("requires portable certification verification");
    await expect(
      registry.publish({
        certificationVerification: {
          bundle: {},
          format: 1,
          identity,
          kind: "sigstore-bundle",
        },
        releaseRoot: fixture.releaseRoot,
      }),
    ).rejects.toThrow("verification requires certification");
    await expect(
      registry.publish({
        certification,
        certificationRequirement: "installed",
        certificationVerification: {
          bundle: { value: "x".repeat(1_048_576) },
          format: 1,
          identity,
          kind: "sigstore-bundle",
        },
        releaseRoot: fixture.releaseRoot,
      }),
    ).rejects.toThrow("exceeds the configured limit");
  });

  test("accepts Expo release metadata and rejects edited certification content", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("expo");
    fixture.metadata.engine = "expo";
    await Bun.write(
      path.join(fixture.releaseRoot, "release.json"),
      `${JSON.stringify(fixture.metadata)}\n`,
    );
    const registry = createNativeReleaseRegistry({ store: memory.store });
    expect(
      (await registry.publish({ releaseRoot: fixture.releaseRoot })).record
        .metadata.engine,
    ).toBe("expo");
    const certification = certificationFor(fixture.metadata);
    certification.generatedAt = "2026-09-16T12:06:00.000Z";
    await expect(
      registry.publish({
        certification,
        certificationRequirement: "installed",
        releaseRoot: fixture.releaseRoot,
      }),
    ).rejects.toThrow("content digest");
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
    if (!("artifactKey" in published.record))
      throw new Error("expected a stored release");
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

const provenanceFor = (runId: number): NativeReleaseArtifactProvenance => ({
  kind: "github-actions",
  repository: "example/absolute-app",
  runAttempt: 1,
  runId,
  sha: "c".repeat(40),
  workflowRef:
    "example/absolute-app/.github/workflows/absolute-mobile.yml@refs/tags/absolutejs-studio-native/run",
});

describe("native release registry with external artifacts", () => {
  test("records a release by digest and provenance without storing its bytes", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("external");
    let runId = 41;
    const registry = createNativeReleaseRegistry({
      clock: () => new Date("2026-10-27T12:00:00.000Z"),
      externalArtifacts: { provenance: () => provenanceFor(runId) },
      store: memory.store,
    });
    const first = await registry.publish({
      certification: certificationFor(fixture.metadata),
      releaseRoot: fixture.releaseRoot,
    });

    expect(first.record).toEqual({
      artifact: { provenance: provenanceFor(41), retention: "external" },
      format: 1,
      metadata: fixture.metadata,
    });
    expect(memory.puts.some((key) => key.endsWith("app-release.aab"))).toBe(
      false,
    );
    expect(
      await registry.read({
        appId: fixture.metadata.appId,
        platform: "android",
        releaseId: fixture.metadata.releaseId,
      }),
    ).toEqual(first.record);

    // A promotion run re-publishes the restored release from a later run; the
    // record keeps the provenance of the run that built it.
    runId = 42;
    const again = await registry.publish({ releaseRoot: fixture.releaseRoot });
    expect(again.reused).toBe(true);
    expect(again.record).toEqual(first.record);

    if (!first.certification) throw new Error("expected certification");
    const channel = await registry.promote({
      appId: fixture.metadata.appId,
      certificationId: first.certification.certificationId,
      certificationRequirement: "installed",
      channel: "production",
      platform: "android",
      releaseId: fixture.metadata.releaseId,
    });
    expect(channel).toMatchObject({
      releaseId: fixture.metadata.releaseId,
      sha256: fixture.metadata.sha256,
    });
    expect(
      await registry.resolve({
        appId: fixture.metadata.appId,
        channel: "production",
        platform: "android",
      }),
    ).toEqual({ channel, record: first.record });
  });

  test("still checks the local artifact before recording it", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("tampered");
    const registry = createNativeReleaseRegistry({
      externalArtifacts: { provenance: () => provenanceFor(7) },
      store: memory.store,
    });
    await Bun.write(
      path.join(fixture.releaseRoot, fixture.metadata.artifact),
      "android-aab-tamperex",
    );
    await expect(
      registry.publish({ releaseRoot: fixture.releaseRoot }),
    ).rejects.toThrow("artifact digest does not match");
    expect(memory.puts).toEqual([]);
  });

  test("refuses invalid provenance before writing anything", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("provenance");
    const registry = createNativeReleaseRegistry({
      externalArtifacts: {
        provenance: () => ({
          ...provenanceFor(7),
          workflowRef:
            "someone/else/.github/workflows/release.yml@refs/heads/main",
        }),
      },
      store: memory.store,
    });
    await expect(
      registry.publish({ releaseRoot: fixture.releaseRoot }),
    ).rejects.toThrow("artifact provenance is invalid");
    expect(memory.puts).toEqual([]);
  });

  test("reads both kinds of record whichever mode the registry is in", async () => {
    const memory = memoryStore();
    const external = await releaseFixture("mixed-external");
    const stored = await releaseFixture("mixed-stored");
    const recording = createNativeReleaseRegistry({
      externalArtifacts: { provenance: () => provenanceFor(9) },
      store: memory.store,
    });
    const retaining = createNativeReleaseRegistry({ store: memory.store });
    const externalRecord = (
      await recording.publish({ releaseRoot: external.releaseRoot })
    ).record;
    const storedRecord = (
      await retaining.publish({ releaseRoot: stored.releaseRoot })
    ).record;

    for (const registry of [recording, retaining]) {
      expect(
        await registry.read({
          appId: external.metadata.appId,
          platform: "android",
          releaseId: external.metadata.releaseId,
        }),
      ).toEqual(externalRecord);
      expect(
        await registry.read({
          appId: stored.metadata.appId,
          platform: "android",
          releaseId: stored.metadata.releaseId,
        }),
      ).toEqual(storedRecord);
    }

    // A release stored with its bytes keeps its byte check in either mode.
    if (!("artifactKey" in storedRecord))
      throw new Error("expected a stored release");
    memory.objects.delete(storedRecord.artifactKey);
    await expect(
      recording.read({
        appId: stored.metadata.appId,
        platform: "android",
        releaseId: stored.metadata.releaseId,
      }),
    ).rejects.toThrow("artifact does not match its immutable identity");
  });

  test("rejects a record that claims both or neither artifact form", async () => {
    const memory = memoryStore();
    const fixture = await releaseFixture("ambiguous");
    const registry = createNativeReleaseRegistry({
      externalArtifacts: { provenance: () => provenanceFor(3) },
      store: memory.store,
    });
    await registry.publish({ releaseRoot: fixture.releaseRoot });
    const key = memory.puts.find((item) => item.endsWith("release.json"));
    if (!key) throw new Error("expected a release record");
    const rewrite = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      memory.objects.set(key, {
        bytes,
        metadata: {
          releaseId: fixture.metadata.releaseId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
    };
    const lookup = {
      appId: fixture.metadata.appId,
      platform: "android" as const,
      releaseId: fixture.metadata.releaseId,
    };
    const original = await registry.read(lookup);

    rewrite({ ...original, artifactKey: "anything/app-release.aab" });
    await expect(registry.read(lookup)).rejects.toThrow(
      "Native release record is invalid",
    );
    rewrite({ format: 1, metadata: fixture.metadata });
    await expect(registry.read(lookup)).rejects.toThrow(
      "Native release record is invalid",
    );
  });

  test("reads provenance from the GitHub Actions environment", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "example/absolute-app",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123456",
      GITHUB_SHA: "d".repeat(40),
      GITHUB_WORKFLOW_REF:
        "example/absolute-app/.github/workflows/absolute-mobile.yml@refs/tags/absolutejs-studio-native/run",
    };
    expect(githubActionsArtifactProvenance(env)).toEqual({
      kind: "github-actions",
      repository: "example/absolute-app",
      runAttempt: 2,
      runId: 123456,
      sha: "d".repeat(40),
      workflowRef: env.GITHUB_WORKFLOW_REF,
    });
    expect(() =>
      githubActionsArtifactProvenance({ ...env, GITHUB_ACTIONS: undefined }),
    ).toThrow("requires a GitHub Actions run");
    expect(() =>
      githubActionsArtifactProvenance({ ...env, GITHUB_RUN_ID: undefined }),
    ).toThrow("artifact provenance is invalid");
  });
});
