import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { modelRef, type ModelSelection } from "@penelope/contract";

import { Backend } from "./backend.ts";
import { ConfigError, readConfig, type Config } from "./config.ts";
import { MemoryEvalError, readPurpose, snapshotCommit, snapshotLive } from "./memory-snapshot.ts";
import { memoryReadTools } from "./night-tools.ts";
import { lastAssistant, openSession } from "./pi.ts";

const USAGE = `Usage: penelope-memory-eval [--at HASH|YYYY-MM-DD] [--only NUMBER] [--show]
       penelope-memory-eval --compare LEFT_ID RIGHT_ID [--show]
`;
const PROMPT = "This is a memory evaluation. The available tools read the selected memory snapshot. Answer the question using that memory and say what is missing if it does not support an answer.";
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

interface Dependencies {
  runtime: (workspace: string) => Promise<ModelRuntime>;
  settings: () => SettingsManager;
  selection: () => Promise<ModelSelection | null>;
}
interface Row extends ModelSelection {
  number: number;
  question: string;
  answer: string;
  files: string[];
  calls: number;
  tokens: number;
  seconds: number;
}
interface Result {
  version: 1;
  at: string | null;
  started: string;
  rows: Row[];
}

function argumentsOf(args: readonly string[]) {
  let show = false;
  let at: string | undefined;
  let only: number | undefined;
  let compare: [string, string] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--show" && !show) show = true;
    else if (arg === "--at" && at === undefined && args[i + 1] && !args[i + 1]!.startsWith("-")) at = args[++i];
    else if (arg === "--only" && only === undefined && /^[1-9][0-9]*$/.test(args[i + 1] ?? "")) only = Number(args[++i]);
    else if (arg === "--compare" && !compare && ID.test(args[i + 1] ?? "") && ID.test(args[i + 2] ?? "")) {
      compare = [args[++i]!, args[++i]!];
    } else throw new MemoryEvalError(USAGE.trimEnd());
  }
  if (compare && (at !== undefined || only !== undefined)) throw new MemoryEvalError(USAGE.trimEnd());
  return { show, at, only, compare };
}

function questionsOf(purpose: string): string[] {
  const questions: string[] = [];
  let section = false;
  let found = false;
  let fence: string | undefined;
  for (const raw of purpose.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1]?.startsWith(fence) && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (line === "## 答えられるべき問い") {
      if (found) throw new MemoryEvalError("PURPOSE.md has more than one question section.");
      found = section = true;
    } else if (/^#{1,2} /.test(line)) section = false;
    else if (section && line) {
      if (!line.startsWith("- ") || !line.slice(2).trim()) throw new MemoryEvalError("Use one '- ' bullet per question in PURPOSE.md.");
      questions.push(line.slice(2).trim());
    }
    if (marker) fence = marker[1];
  }
  if (questions.length === 0) throw new MemoryEvalError("No questions in the '## 答えられるべき問い' section of PURPOSE.md.");
  if (new Set(questions).size !== questions.length) throw new MemoryEvalError("Questions in PURPOSE.md must be distinct.");
  return questions;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const overlaps = (left: string, right: string) => contains(left, right) || contains(right, left);

async function resultDirectory(config: Config, create: boolean): Promise<string> {
  const home = resolve(config.home);
  const dir = join(home, ".penelope-memory-eval");
  const state = [config.agentDir, config.sessionDir, config.subAgentDir, config.sourcesDir, config.jobDir];
  if (overlaps(config.memoryDir, dir) || await realpath(home) !== home ||
      state.some((path) => overlaps(path, dir) || (create && overlaps(path, config.memoryDir)))) {
    throw new MemoryEvalError("Evaluation requires separate memory, state and result directories.");
  }
  if (create) await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new MemoryEvalError("The result directory must be a private directory owned by the sandbox user (0700).");
  }
  return dir;
}

const metrics = (row: Row) => `${row.model} (${row.thinking}), Files: ${row.files.length}, tools: ${row.calls}, tokens: ${row.tokens}, seconds: ${row.seconds.toFixed(3)}`;
const details = (row: Row) => `\n${row.answer}\nFiles read: ${JSON.stringify(row.files)}\n`;

async function compareResults(dir: string, ids: [string, string], show: boolean): Promise<string> {
  const results = await Promise.all(ids.map(async (id) => {
    const input = await open(join(dir, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await input.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new MemoryEvalError("Not a private result file.");
      const result = JSON.parse(await input.readFile("utf8")) as Result;
      if (result.version !== 1) throw new MemoryEvalError("Unsupported result format.");
      return new Map(result.rows.map((row) => [row.question, row]));
    } finally {
      await input.close();
    }
  }));
  const [left, right] = results as [Map<string, Row>, Map<string, Row>];
  const questions = [...new Set([...left.keys(), ...right.keys()])];
  const output = questions.map((question, i) => {
    const sides = [left.get(question), right.get(question)].map((row, side) => `  ${side === 0 ? "Left" : "Right"}: ${row
      ? metrics(row) + (show ? details(row) : "") : "—"}`);
    return `#${i + 1}${show ? `: ${question}` : ""}\n${sides.join("\n")}`;
  });
  return `Questions: ${questions.length}\n${output.join("\n")}\n`;
}

async function answerQuestion(config: Config, deps: Dependencies, modelRuntime: ModelRuntime,
  selection: ModelSelection | null, workspace: string, memory: string, question: string, number: number): Promise<Row> {
  const files = new Set<string>();
  const manager = SessionManager.inMemory(memory);
  const { session } = await openSession({
    config: { ...config, home: workspace, agentDir: workspace }, modelRuntime,
    settings: () => SettingsManager.inMemory({ ...deps.settings().getSettings(), packages: [] }),
    tools: memoryReadTools(memory, (path) => files.add(path)), extensions: [], fileOnly: true, log: () => {},
  }, PROMPT, manager, memory);
  let calls = 0;
  const unsubscribe = session.subscribe((event) => { if (event.type === "tool_execution_start") calls++; });
  try {
    // As in the daytime turn, an unavailable saved model leaves the session default in place.
    if (selection) {
      const available = await modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(5_000) });
      const selected = available.find((model) => modelRef(model) === selection.model);
      if (selected) {
        await session.setModel(selected);
        session.setThinkingLevel(selection.thinking);
      }
    }
    const model = session.model;
    if (!model) throw new MemoryEvalError("No daytime model is available.");
    const start = performance.now();
    await session.prompt(question, { expandPromptTemplates: false });
    await session.waitForIdle();
    const last = lastAssistant(session.messages);
    if (!last || last.stopReason === "error" || last.stopReason === "aborted") throw new MemoryEvalError(`The model did not answer question #${number}.`);
    const tokens = manager.getEntries().reduce((sum, entry) => {
      if (entry.type === "message" && entry.message.role === "assistant") return sum + entry.message.usage.totalTokens;
      if (entry.type === "usage" || entry.type === "compaction") return sum + (entry.usage?.totalTokens ?? 0);
      return sum;
    }, 0);
    return {
      number, question, answer: last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      files: [...files].sort(), calls, tokens, seconds: (performance.now() - start) / 1000,
      model: modelRef(model), thinking: session.thinkingLevel,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function runMemoryEval(args: readonly string[], config: Config, deps: Dependencies): Promise<string> {
  if (args.length === 1 && args[0] === "--help") return USAGE;
  const { show, at, only, compare } = argumentsOf(args);
  const dir = await resultDirectory(config, !compare);
  if (compare) return compareResults(dir, compare, show);

  const workspace = await mkdtemp(join(dir, "scratch-"));
  try {
    const memory = join(workspace, "memory");
    await mkdir(memory);
    // Start from the current questions even if the target predates PURPOSE.md.
    if (!at) await snapshotLive(config.memoryDir, memory);
    const questions = questionsOf(await readPurpose(at ? config.memoryDir : memory));
    if (only !== undefined && only > questions.length) throw new MemoryEvalError("--only does not name a question in PURPOSE.md.");
    const commit = at ? await snapshotCommit(config.memoryDir, memory, at) : null;
    const selection = await deps.selection();
    const runtime = await deps.runtime(workspace);
    const started = new Date().toISOString();
    const rows: Row[] = [];
    for (const [i, question] of questions.entries()) {
      if (only === undefined || only === i + 1) rows.push(await answerQuestion(config, deps, runtime, selection, workspace, memory, question, i + 1));
    }
    const path = join(dir, `${randomUUID()}.json`);
    const result: Result = { version: 1, at: commit, started, rows };
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return [`Questions: ${rows.length}`, ...rows.map((row) => `#${row.number}: ${metrics(row)}${show
      ? `\n${row.question}${details(row)}` : ""}`), `Result: ${path}\n`].join("\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runtimeIn(config: Config, workspace: string): Promise<ModelRuntime> {
  // Pi can refresh credentials and its model cache. Give it private copies,
  // never the files that the main runner may be using at the same time.
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    const target = join(workspace, name);
    try {
      await copyFile(join(config.agentDir, name), target, constants.COPYFILE_EXCL);
      await chmod(target, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return ModelRuntime.create({ authPath: join(workspace, "auth.json"), modelsPath: join(workspace, "models.json") });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === "--help") process.stdout.write(USAGE);
    else {
      const config = readConfig(process.env);
      const backend = new Backend({ ...config.backend, agent: config.agent });
      process.stdout.write(await runMemoryEval(args, config, {
        runtime: (workspace) => runtimeIn(config, workspace),
        settings: () => SettingsManager.create(config.home, config.agentDir),
        selection: async () => {
          try {
            return (await backend.readModelSelection(AbortSignal.timeout(5_000))).selection;
          } catch {
            throw new MemoryEvalError("Cannot read the daytime model selection from the backend.");
          }
        },
      }));
    }
  } catch (error) {
    // Filesystem, provider, and Git diagnostics may include private content.
    const message = error instanceof ConfigError ? "The sandbox runner configuration is invalid."
      : error instanceof MemoryEvalError ? error.message : "Memory evaluation failed.";
    process.stderr.write(`penelope-memory-eval: ${message}\n`);
    process.exitCode = 1;
  }
}
