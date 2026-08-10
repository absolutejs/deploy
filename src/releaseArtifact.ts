import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 2_147_483_648;
const ERROR_DETAIL_LIMIT = 500;
const SAFE_RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ReleaseArtifactMetadata = {
  bytes: number;
  releaseId: string;
  sha256: string;
};

export type CreatedReleaseArtifact = {
  dispose: () => Promise<void>;
  file: Bun.BunFile;
  metadata: ReleaseArtifactMetadata;
  path: string;
};

export class ReleaseArtifactError extends Error {}

const run = async (command: string[]) => {
  const process = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0)
    throw new ReleaseArtifactError(
      `${command[0]} failed (${exitCode}): ${stderr.slice(0, ERROR_DETAIL_LIMIT)}`,
    );

  return stdout;
};

const assertReleaseId = (value: string) => {
  if (!SAFE_RELEASE_ID.test(value))
    throw new ReleaseArtifactError("Release id is invalid");

  return value;
};

const assertExclude = (value: string) => {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "..") ||
    /[\0\r\n]/.test(value)
  )
    throw new ReleaseArtifactError(`Invalid release exclusion: ${value}`);

  return value.replace(/^\.\//, "");
};

const sha256File = async (file: Blob) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);

  return hasher.digest("hex");
};

export const createReleaseArtifact = async (options: {
  exclude?: string[];
  releaseId?: string;
  sourceRoot: string;
  temporaryRoot?: string;
}): Promise<CreatedReleaseArtifact> => {
  const releaseId = assertReleaseId(options.releaseId ?? crypto.randomUUID());
  const source = path.resolve(options.sourceRoot);
  const sourceStats = await stat(source).catch(() => null);
  if (!sourceStats?.isDirectory())
    throw new ReleaseArtifactError("Release source root is not a directory");
  if (!(await Bun.file(path.join(source, "package.json")).exists()))
    throw new ReleaseArtifactError("Release source has no package.json");
  const temporary = await mkdtemp(
    path.join(options.temporaryRoot ?? tmpdir(), "absolutejs-release-"),
  );
  const archivePath = path.join(temporary, `${releaseId}.tgz`);
  try {
    await run([
      "tar",
      "-czf",
      archivePath,
      ...(options.exclude ?? []).map(
        (value) => `--exclude=./${assertExclude(value)}`,
      ),
      "-C",
      source,
      ".",
    ]);
    const file = Bun.file(archivePath);

    return {
      dispose: () => rm(temporary, { force: true, recursive: true }),
      file,
      metadata: {
        bytes: file.size,
        releaseId,
        sha256: await sha256File(file),
      },
      path: archivePath,
    };
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
};

export const receiveReleaseArtifact = async (options: {
  destination: string;
  expectedBytes: number;
  expectedSha256: string;
  maxBytes?: number;
  stream: ReadableStream<Uint8Array>;
}) => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 1 ||
    options.expectedBytes > maxBytes ||
    !/^[a-f0-9]{64}$/.test(options.expectedSha256)
  )
    throw new ReleaseArtifactError("Release artifact metadata is invalid");
  await mkdir(path.dirname(options.destination), { recursive: true });
  const writer = Bun.file(options.destination).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = options.stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > options.expectedBytes || bytes > maxBytes)
        throw new ReleaseArtifactError(
          "Release artifact exceeds its declared size",
        );
      hasher.update(chunk);
      writer.write(chunk);
    }
  } catch (error) {
    await rm(options.destination, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
    await writer.end();
  }
  if (
    bytes !== options.expectedBytes ||
    hasher.digest("hex") !== options.expectedSha256
  ) {
    await rm(options.destination, { force: true });
    throw new ReleaseArtifactError(
      "Release artifact integrity verification failed",
    );
  }

  return { bytes, sha256: options.expectedSha256 };
};

export const extractReleaseArtifact = async (options: {
  archivePath: string;
  destination: string;
}) => {
  const [names, verbose] = await Promise.all([
    run(["tar", "-tzf", options.archivePath]),
    run(["tar", "-tvzf", options.archivePath]),
  ]);
  const unsafePath = names
    .split("\n")
    .filter(Boolean)
    .some(
      (entry) =>
        entry.startsWith("/") || entry.split("/").some((part) => part === ".."),
    );
  const unsafeType = verbose
    .split("\n")
    .filter(Boolean)
    .some((entry) => entry[0] !== "-" && entry[0] !== "d");
  if (unsafePath || unsafeType)
    throw new ReleaseArtifactError("Release artifact contains an unsafe entry");
  await rm(options.destination, { force: true, recursive: true });
  await mkdir(options.destination, { recursive: true });
  await run([
    "tar",
    "-xzf",
    options.archivePath,
    "--no-same-owner",
    "--no-same-permissions",
    "-C",
    options.destination,
  ]);
  if (
    !(await Bun.file(path.join(options.destination, "package.json")).exists())
  )
    throw new ReleaseArtifactError("Release artifact has no package.json");

  return { extracted: true } as const;
};
