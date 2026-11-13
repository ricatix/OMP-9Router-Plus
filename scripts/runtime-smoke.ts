// allow: SIZE_OK - task 8 pins one manual smoke entry that owns both the
// scripted scenarios and the later interactive CLI harness.
/**
 * Manual runtime smoke entry for task 8 and the later F3 terminal QA.
 *
 * Scripted scenarios delegate to the permanent integration test with a
 * task-owned environment, capture the raw log, and verify the evidence file.
 * The interactive scenario launches the installed OMP CLI against the build
 * artifact with an isolated HOME/agentDir and a loopback router; it never
 * touches the user's profile or terminal state.
 *
 * Usage:
 *   bun scripts/runtime-smoke.ts --scenario startup-and-wire --evidence-dir .omo/evidence/omp-9router-plus
 *   bun scripts/runtime-smoke.ts --scenario failure-and-restart --evidence-dir .omo/evidence/omp-9router-plus
 *   bun scripts/runtime-smoke.ts --scenario interactive --interactive-outcome success
 *   bun scripts/runtime-smoke.ts --scenario interactive --interactive-outcome failure
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type FakeRouter,
  startFakeRouter,
} from "../tests/fixtures/fake-router.js";

const repoRoot = resolve(import.meta.dir, "..");
const integrationTest = join(repoRoot, "tests", "runtime.integration.test.ts");
const distPath = join(repoRoot, "dist", "index.js");
const cliPath = join(
  repoRoot,
  "node_modules",
  "@oh-my-pi",
  "pi-coding-agent",
  "dist",
  "cli.js",
);

interface Args {
  readonly scenario:
    | "startup-and-wire"
    | "failure-and-restart"
    | "interactive"
    | "all";
  readonly evidenceDir: string;
  readonly interactiveOutcome: "success" | "failure";
}

interface ScenarioResult {
  readonly scenario: string;
  readonly command: string;
  readonly exitCode: number;
  readonly log: string;
  readonly evidence: string | null;
  readonly evidenceStatus: "passed" | "failed" | "missing" | "not-applicable";
}

const args = parseArgs(process.argv.slice(2));
const evidenceDir = isAbsolute(args.evidenceDir)
  ? args.evidenceDir
  : resolve(repoRoot, args.evidenceDir);
await mkdir(evidenceDir, { recursive: true });

if (!(await Bun.file(distPath).exists())) {
  console.error(
    "dist/index.js is missing. Run `bun run build` before the runtime smoke.",
  );
  process.exit(1);
}

if (args.scenario === "interactive") {
  const code = await runInteractive(args, evidenceDir);
  process.exit(code);
}

const selected =
  args.scenario === "all"
    ? (["startup-and-wire", "failure-and-restart"] as const)
    : ([args.scenario] as const);
const results: ScenarioResult[] = [];
for (const scenario of selected) {
  const result = await runScriptedScenario(scenario, evidenceDir);
  results.push(result);
  if (result.exitCode !== 0 || result.evidenceStatus !== "passed") break;
}

const artifact = await readArtifact();
await writeSummary(results, artifact);
const failed = results.some(
  (result) => result.exitCode !== 0 || result.evidenceStatus !== "passed",
);
process.exit(failed ? 1 : 0);

async function runScriptedScenario(
  scenario: "startup-and-wire" | "failure-and-restart",
  directory: string,
): Promise<ScenarioResult> {
  const command = `${process.execPath} test tests/runtime.integration.test.ts`;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env.RUNTIME_SCENARIO = scenario;
  env.EVIDENCE_DIR = directory;
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", integrationTest],
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 180_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const log = `${stdout}${stderr}`;
  const logName = `task-8-${scenario}.log`;
  await writeFile(join(directory, logName), log, "utf8");
  const evidenceName =
    scenario === "startup-and-wire"
      ? "task-8-startup-wire.json"
      : "task-8-failure-restart.json";
  const evidencePath = join(directory, evidenceName);
  const evidenceStatus = await readEvidenceStatus(evidencePath, exitCode);
  console.log(
    `[${scenario}] exit=${exitCode} evidence=${evidenceStatus} log=${join(directory, logName)}`,
  );
  return {
    scenario,
    command,
    exitCode,
    log: join(directory, logName),
    evidence: (await Bun.file(evidencePath).exists()) ? evidencePath : null,
    evidenceStatus,
  };
}

async function readEvidenceStatus(
  path: string,
  exitCode: number,
): Promise<ScenarioResult["evidenceStatus"]> {
  if (!(await Bun.file(path).exists())) return "missing";
  try {
    const value = (await Bun.file(path).json()) as { status?: unknown };
    if (value.status !== "passed") return "failed";
    return exitCode === 0 ? "passed" : "failed";
  } catch {
    return "failed";
  }
}

async function runInteractive(
  options: Args,
  directory: string,
): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "omp-runtime-interactive-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const workDir = join(root, "work");
  const tempDir = join(root, "tmp");
  for (const item of [homeDir, agentDir, workDir, tempDir])
    await mkdir(item, { recursive: true });

  const roster = [
    {
      id: "cx/test-model",
      kind: "llm",
      name: "CX Test Model",
      capabilities: {
        reasoning: true,
        tools: false,
        vision: false,
        contextWindow: 65_536,
        maxOutput: 8_192,
      },
    },
    {
      id: "glm/glm-5.2",
      kind: "llm",
      name: "GLM 5.2",
      capabilities: {
        reasoning: true,
        tools: true,
        vision: false,
        contextWindow: 65_536,
        maxOutput: 8_192,
      },
    },
  ] as const;
  const server: FakeRouter = startFakeRouter({
    roster,
    mode: options.interactiveOutcome === "failure" ? "unauthorized" : "success",
  });
  const cacheDir = join(homeDir, ".cache", "omp-9router-plus");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "models.dev.api.json"),
    JSON.stringify({ timestamp: Date.now(), data: {} }),
  );
  await writeFile(
    join(cacheDir, "models.dev.models.json"),
    JSON.stringify({ timestamp: Date.now(), data: {} }),
  );
  await writeModels(
    join(agentDir, "models.yml"),
    server,
    options.interactiveOutcome === "failure" ? "" : "9router/cx/test-model",
  );

  const launchPath = join(directory, "task-8-interactive-launch.json");
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const launch = {
    scenario: "interactive",
    outcome: options.interactiveOutcome,
    tty,
    command: [
      "omp",
      "-e",
      "dist/index.js",
      "--no-extensions",
      ...(options.interactiveOutcome === "success"
        ? ["--model", "9router/cx/test-model"]
        : []),
      "--no-title",
      "--no-session",
    ],
    artifact: distPath,
    agentDir,
    workDir,
    loopbackBaseUrl: server.nineRouterBaseUrl,
    manualQaClaimed: false,
    note: "F3 must observe the picker, diagnostic, and one successful prompt in this task-owned terminal.",
  };
  await writeFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`);
  if (!tty) {
    await writeFile(
      join(directory, "task-8-interactive.log"),
      "interactive scenario requires a TTY; run it from a task-owned terminal.\n",
      "utf8",
    );
    server.stop();
    await rm(root, { recursive: true, force: true });
    console.error(
      "interactive scenario requires a TTY; no manual QA was performed.",
    );
    return 2;
  }

  const env = isolatedEnvironment({ homeDir, agentDir, workDir, tempDir });
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      cliPath,
      "-e",
      distPath,
      "--no-extensions",
      ...(options.interactiveOutcome === "success"
        ? ["--model", "9router/cx/test-model"]
        : []),
      "--no-lsp",
      "--no-skills",
      "--no-rules",
      "--no-context-files",
      "--no-title",
      "--no-session",
    ],
    cwd: workDir,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let exitCode = 1;
  try {
    exitCode = await proc.exited;
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
    console.log(`[interactive] exit=${exitCode} launch=${launchPath}`);
  }
  return exitCode;
}

async function writeModels(
  path: string,
  server: FakeRouter,
  model: string,
): Promise<void> {
  const lines = [
    "providers:",
    '  "9router":',
    `    baseUrl: ${JSON.stringify(server.nineRouterBaseUrl)}`,
    "    api: openai-completions",
    '    apiKey: "task8-interactive-key"',
    '  "other":',
    `    baseUrl: ${JSON.stringify(server.otherBaseUrl)}`,
    "    api: openai-completions",
    '    apiKey: "task8-other-key"',
    "    models:",
    "      - id: keep-me",
    "        name: keep-me",
    "        reasoning: false",
    "        input: [text]",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    "        contextWindow: 32768",
    "        maxTokens: 4096",
  ];
  await writeFile(path, `${lines.join("\n")}\n`);
  if (model !== "") console.log(`interactive model selector: ${model}`);
}

function isolatedEnvironment(options: {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly workDir: string;
  readonly tempDir: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  for (const key of [
    "OMP_PROFILE",
    "PI_PROFILE",
    "OPENCODE_CONFIG_DIR",
    "NINE_ROUTER_API_KEY",
    "OTHER_KEY",
  ])
    delete env[key];
  env.HOME = options.homeDir;
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env.XDG_CACHE_HOME = join(options.homeDir, ".cache");
  env.XDG_CONFIG_HOME = join(options.homeDir, ".config");
  env.XDG_DATA_HOME = join(options.homeDir, ".local", "share");
  env.XDG_STATE_HOME = join(options.homeDir, ".local", "state");
  env.TMPDIR = options.tempDir;
  env.DO_NOT_TRACK = "1";
  env.OMP_DISABLE_TELEMETRY = "1";
  return env;
}

async function writeSummary(
  results: readonly ScenarioResult[],
  artifact: { readonly sha256: string; readonly bytes: number },
): Promise<void> {
  const hostVersion = await readHostVersion();
  const cleanupFiles: string[] = [];
  for (const name of ["task-8-cleanup.json"]) {
    const path = join(evidenceDir, name);
    if (await Bun.file(path).exists()) cleanupFiles.push(path);
  }
  const interactiveLaunchPath = join(
    evidenceDir,
    "task-8-interactive-launch.json",
  );
  const interactiveLaunch = (await Bun.file(interactiveLaunchPath).exists())
    ? ((await Bun.file(interactiveLaunchPath).json()) as {
        outcome?: unknown;
        tty?: unknown;
        manualQaClaimed?: unknown;
      })
    : null;
  const summary = {
    planTask: 8,
    generatedAt: new Date().toISOString(),
    status: results.every(
      (result) => result.exitCode === 0 && result.evidenceStatus === "passed",
    )
      ? "passed"
      : "failed",
    versions: {
      bun: Bun.version,
      host: hostVersion,
    },
    artifact,
    scenarios: results,
    cleanupReceipts: cleanupFiles,
    manualCommands: {
      build: "bun run build",
      startupAndWire:
        "bun scripts/runtime-smoke.ts --scenario startup-and-wire --evidence-dir .omo/evidence/omp-9router-plus",
      failureAndRestart:
        "bun scripts/runtime-smoke.ts --scenario failure-and-restart --evidence-dir .omo/evidence/omp-9router-plus",
      all: "bun scripts/runtime-smoke.ts --scenario all --evidence-dir .omo/evidence/omp-9router-plus",
      interactiveSuccess:
        "bun scripts/runtime-smoke.ts --scenario interactive --interactive-outcome success",
      interactiveFailure:
        "bun scripts/runtime-smoke.ts --scenario interactive --interactive-outcome failure",
      integrationFile: "bun test tests/runtime.integration.test.ts",
    },
    interactiveHarness: interactiveLaunch
      ? {
          launchFile: interactiveLaunchPath,
          outcome: interactiveLaunch.outcome ?? null,
          tty: interactiveLaunch.tty === true,
          manualQaClaimed: interactiveLaunch.manualQaClaimed === true,
          status:
            interactiveLaunch.tty === true
              ? "launched-in-task-owned-terminal"
              : "not-launched-no-tty",
        }
      : null,
    limitations: [
      "The captured payload proves the request the host sends, not upstream 9Router effort enforcement.",
      "A changed roster requires a new OMP process; no in-process factory hot reload is claimed.",
    ],
    task9Recommendation: {
      scriptEntry:
        '"test:integration": "bun scripts/runtime-smoke.ts" (defaults to both scripted scenarios)',
      prerequisite: "bun run build",
      scenarioArgument:
        "--scenario startup-and-wire|failure-and-restart|interactive",
      evidenceEnv: "EVIDENCE_DIR",
      integrationFile: "tests/runtime.integration.test.ts",
      note: "Bun strips args passed to `bun test`; the smoke script maps --scenario to RUNTIME_SCENARIO before spawning the integration file.",
    },
  };
  const path = join(evidenceDir, "task-8-summary.json");
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`summary=${path}`);
}

async function readArtifact(): Promise<{
  readonly sha256: string;
  readonly bytes: number;
}> {
  const bytes = await Bun.file(distPath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { sha256: hasher.digest("hex"), bytes: bytes.byteLength };
}

async function readHostVersion(): Promise<string> {
  try {
    const value = (await Bun.file(
      join(
        repoRoot,
        "node_modules",
        "@oh-my-pi",
        "pi-coding-agent",
        "package.json",
      ),
    ).json()) as { version?: unknown };
    return typeof value.version === "string" ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}

function parseArgs(argv: readonly string[]): Args {
  let scenario: Args["scenario"] = "all";
  let evidenceDir = join(".omo", "evidence", "omp-9router-plus");
  let interactiveOutcome: Args["interactiveOutcome"] = "success";
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--scenario" && next !== undefined) {
      if (
        next === "startup-and-wire" ||
        next === "failure-and-restart" ||
        next === "interactive" ||
        next === "all"
      )
        scenario = next;
      index++;
    } else if (value.startsWith("--scenario=")) {
      const candidate = value.slice("--scenario=".length);
      if (
        candidate === "startup-and-wire" ||
        candidate === "failure-and-restart" ||
        candidate === "interactive" ||
        candidate === "all"
      )
        scenario = candidate;
    } else if (value === "--evidence-dir" && next !== undefined) {
      evidenceDir = next;
      index++;
    } else if (value.startsWith("--evidence-dir=")) {
      evidenceDir = value.slice("--evidence-dir=".length);
    } else if (value === "--interactive-outcome" && next !== undefined) {
      if (next === "success" || next === "failure") interactiveOutcome = next;
      index++;
    } else if (value.startsWith("--interactive-outcome=")) {
      const candidate = value.slice("--interactive-outcome=".length);
      if (candidate === "success" || candidate === "failure")
        interactiveOutcome = candidate;
    } else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: bun scripts/runtime-smoke.ts --scenario <startup-and-wire|failure-and-restart|interactive|all> --evidence-dir <dir> [--interactive-outcome success|failure]",
      );
      process.exit(0);
    }
  }
  return { scenario, evidenceDir, interactiveOutcome };
}
