import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createReleaseArtifact,
  extractReleaseArtifact,
  receiveReleaseArtifact,
  ReleaseArtifactError,
} from "../src/releaseArtifact";

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "absolutejs-artifact-test-"));
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("release artifacts", () => {
  test("packages, verifies, and extracts an immutable project stream", async () => {
    const root = await temporary();
    const source = path.join(root, "source");
    await mkdir(path.join(source, "node_modules"), { recursive: true });
    await Bun.write(path.join(source, "package.json"), '{"name":"site"}');
    await Bun.write(path.join(source, "index.ts"), "export const site = true;");
    await Bun.write(path.join(source, "node_modules", "ignored"), "no");
    const created = await createReleaseArtifact({
      exclude: ["node_modules"],
      releaseId: "release-1",
      sourceRoot: source,
      temporaryRoot: root,
    });
    const received = path.join(root, "received.tgz");
    await receiveReleaseArtifact({
      destination: received,
      expectedBytes: created.metadata.bytes,
      expectedSha256: created.metadata.sha256,
      stream: created.file.stream(),
    });
    const extracted = path.join(root, "extracted");
    await extractReleaseArtifact({
      archivePath: received,
      destination: extracted,
    });

    expect(await readFile(path.join(extracted, "index.ts"), "utf8")).toContain(
      "site = true",
    );
    expect(
      await Bun.file(path.join(extracted, "node_modules", "ignored")).exists(),
    ).toBe(false);
    await created.dispose();
    expect(await stat(created.path).catch(() => null)).toBeNull();
  });

  test("removes a partial upload when integrity verification fails", async () => {
    const root = await temporary();
    const destination = path.join(root, "bad.tgz");
    await expect(
      receiveReleaseArtifact({
        destination,
        expectedBytes: 4,
        expectedSha256: "0".repeat(64),
        stream: new Blob(["bad"]).stream(),
      }),
    ).rejects.toBeInstanceOf(ReleaseArtifactError);
    expect(await Bun.file(destination).exists()).toBe(false);
  });

  test("rejects link entries before extraction", async () => {
    const root = await temporary();
    const source = path.join(root, "source");
    await mkdir(source, { recursive: true });
    await Bun.write(path.join(source, "package.json"), "{}");
    await symlink("/etc/passwd", path.join(source, "escape"));
    const archive = path.join(root, "unsafe.tgz");
    const process = Bun.spawn(["tar", "-czf", archive, "-C", source, "."], {
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);

    await expect(
      extractReleaseArtifact({
        archivePath: archive,
        destination: path.join(root, "extracted"),
      }),
    ).rejects.toBeInstanceOf(ReleaseArtifactError);
  });
});
