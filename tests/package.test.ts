// allow: SIZE_OK - task 9 pins the artifact guard and broken-artifact
// regression suite beside the package smoke entry it exercises.
/**
 * Package artifact regressions.
 *
 * The happy-path artifact proof lives in `scripts/package-smoke.ts` because it
 * spawns a full native host session. These tests cover the guard functions and
 * the negative controls the plan requires: an extracted copy without its entry
 * or without the generated catalog must fail startup with a meaningful error.
 * Every broken copy is temporary; the real `dist/` tree is never modified.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  copyHostDependencyGraph,
  extractInstalledPackage,
  inspectPackageEntries,
  packProject,
  resolveOmpExtensionEntry,
  runPackagedChild,
} from "../scripts/package-smoke.js";

const packageName = "omp-9router-plus";

const validEntries = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/NOTICE",
  "package/dist/index.js",
  "package/dist/generated/9router-llm-catalog.js",
];

describe("artifact contents", () => {
  test("accepts the expected package files and rejects local material", () => {
    expect(inspectPackageEntries(validEntries).ok).toBe(true);

    const rejected = inspectPackageEntries([
      ...validEntries,
      "package/.omo/evidence/task-9.json",
      "package/tests/package.test.ts",
      "package/node_modules/other/index.js",
      "package/.env",
      "package/dist/index.js.map",
      "package/debug.log",
    ]);
    expect(rejected.ok).toBe(false);
    expect(rejected.forbidden).toHaveLength(6);
    for (const reason of [
      "local plan/evidence",
      "source tests",
      "bundled dependency tree",
      "environment file",
      "source map",
      "log file",
    ])
      expect(rejected.forbidden.join("\n")).toContain(reason);
  });

  test("requires the built entry and generated catalog", () => {
    const missing = inspectPackageEntries([
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/NOTICE",
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join("\n")).toContain("package/dist/index.js");
    expect(missing.errors.join("\n")).toContain(
      "package/dist/generated/9router-llm-catalog.js",
    );
  });
});

describe("extension entry", () => {
  test("resolves the manifest entry inside the package", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-package-entry-"));
    try {
      const packageDir = join(root, "package");
      await mkdir(join(packageDir, "dist"), { recursive: true });
      await writeFile(
        join(packageDir, "package.json"),
        `${JSON.stringify({ name: packageName, omp: { extensions: ["./dist/index.js"] } })}\n`,
      );
      await writeFile(
        join(packageDir, "dist", "index.js"),
        "export default 1;\n",
      );
      const json = (await Bun.file(
        join(packageDir, "package.json"),
      ).json()) as Record<string, unknown>;
      const entry = await resolveOmpExtensionEntry(packageDir, json);
      expect(entry).toBe(join(packageDir, "dist", "index.js"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects escaping and missing entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-package-entry-"));
    try {
      await expect(
        resolveOmpExtensionEntry(join(root, "missing"), {
          name: packageName,
          omp: { extensions: ["../outside.js"] },
        }),
      ).rejects.toThrow(/escapes the package/);
      await expect(
        resolveOmpExtensionEntry(join(root, "missing"), {
          name: packageName,
          omp: { extensions: ["./dist/index.js"] },
        }),
      ).rejects.toThrow(/no such file|ENOENT/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("broken artifact", () => {
  let root: string;
  let installRoot: string;
  let pristinePackage: string;
  let packageJson: Record<string, unknown>;
  let agentDir: string;
  let homeDir: string;
  let workDir: string;
  let tmpDir: string;
  const brokenEvidence: { readonly case: string; readonly message: string }[] =
    [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "omp-package-broken-"));
    installRoot = join(root, "install");
    agentDir = join(root, "agent");
    homeDir = join(root, "home");
    workDir = join(root, "work");
    tmpDir = join(root, "tmp");
    for (const item of [installRoot, agentDir, homeDir, workDir, tmpDir])
      await mkdir(item, { recursive: true });
    const cacheDir = join(homeDir, ".cache", "omp-9router-plus");
    await mkdir(cacheDir, { recursive: true });
    for (const name of ["models.dev.api.json", "models.dev.models.json"])
      await writeFile(
        join(cacheDir, name),
        JSON.stringify({ timestamp: Date.now(), data: {} }),
      );
    await writeFile(
      join(agentDir, "models.yml"),
      `${[
        "providers:",
        '  "9router":',
        '    baseUrl: "http://127.0.0.1:1/v1"',
        "    api: openai-completions",
        '    apiKey: "broken-artifact-fixture"',
      ].join("\n")}\n`,
    );
    const artifact = await packProject(join(root, "pack"));
    await copyHostDependencyGraph(installRoot);
    const installed = await extractInstalledPackage(
      artifact.tarball,
      installRoot,
    );
    packageJson = installed.packageJson;
    pristinePackage = join(root, "pristine");
    await cp(installed.packageDir, pristinePackage, { recursive: true });
  }, 180_000);

  afterAll(async () => {
    const configured = process.env.EVIDENCE_DIR;
    if (configured !== undefined && brokenEvidence.length > 0) {
      const directory = resolve(configured);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "task-9-broken-artifacts.json"),
        `${JSON.stringify({ planTask: 9, cases: brokenEvidence }, null, 2)}\n`,
      );
    }
    await rm(root, { recursive: true, force: true });
  });

  async function runBroken(
    name: string,
    mutate: (packageDir: string) => Promise<void>,
  ) {
    const packageDir = join(installRoot, "node_modules", packageName);
    await rm(packageDir, { recursive: true, force: true });
    await cp(pristinePackage, packageDir, { recursive: true });
    await mutate(packageDir);
    const omp = packageJson.omp as { extensions: readonly string[] };
    const entry = join(packageDir, omp.extensions[0] as string);
    const outcome = await runPackagedChild(
      {
        installRoot,
        entry,
        agentDir,
        workDir,
        homeDir,
        tmpDir,
        modelsPath: join(agentDir, "models.yml"),
        resultPath: join(root, `${name}-result.json`),
      },
      60_000,
    );
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.result?.ok).toBe(false);
    const failure =
      outcome.result !== null && "error" in outcome.result
        ? outcome.result.error
        : outcome.stderr;
    brokenEvidence.push({ case: name, message: failure });
    return failure;
  }

  test("fails startup when the manifest entry is missing", async () => {
    const failure = await runBroken("missing-entry", async (packageDir) => {
      await rm(join(packageDir, "dist", "index.js"));
    });
    expect(failure).toMatch(/dist\/index\.js|no such file|ENOENT|cannot find/i);
  }, 120_000);

  test("fails startup when the generated catalog is missing", async () => {
    const failure = await runBroken("missing-catalog", async (packageDir) => {
      await rm(join(packageDir, "dist", "generated", "9router-llm-catalog.js"));
    });
    expect(failure).toContain("9router-llm-catalog");
  }, 120_000);
});
