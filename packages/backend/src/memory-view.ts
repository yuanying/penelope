import type { DatabaseSync } from "node:sqlite";

import type {
  MemoryBrokenLink, MemoryChange, MemoryChangeResponse, MemoryChangesResponse, MemoryCompareResponse, MemoryCounts,
  MemoryFile, MemoryFileChange, MemoryFileDiff, MemoryFileResponse, MemoryHistoryResponse, MemoryNight,
  MemoryOverviewResponse, MemoryReadCount, MemorySaveRequest, MemorySaveResponse, MemorySearchResponse, MemoryWriter, MemoryWriterFilter,
} from "@penelope/contract";

import { HttpError } from "./http.ts";
import { type GitChange, type GitCommit, MemoryGit, memoryPath, OBJECT_ID, type TreeEntry, type TreeFile } from "./memory-git.ts";
import { type LocalLink, localLinks } from "./memory-links.ts";
import { DAY_MS, MemoryRecord, type MemoryRecordNight } from "./memory-record.ts";
import { dayOf, isTimeZone } from "./record.ts";
import { imageTypeOf } from "./sources.ts";

// Same files and defaults as the runner's prompts.ts and config.ts.
const LAYER = new Set(["PURPOSE.md", "always.md", "personality.md", "handoff.md"]);
export const MEMORY_TEXT_BYTES = 1024 * 1024;
const DEFAULT_FILE_LIMIT = 65536;
const IMAGE_BYTES = 16 * 1024 * 1024;
const LINK_BYTES = 32 * 1024 * 1024;
const LINK_RESULTS = 1000;
const SEARCH_LINES = 100;
const DIFF_LINES = 2000;
const PAGE = 50;

type LastChanges = { head: string; paths: Map<string, GitCommit> };
type LinkCache = { head: string; links: Map<string, LocalLink[]>; broken: MemoryBrokenLink[]; incomplete: boolean };
type SavePlan = { kind: "write"; head: string; file: TreeEntry; original: Buffer; body: Buffer; author: { name: string; email: string } };

export class MemoryView {
  readonly reports: MemoryRecord;
  private readonly git: MemoryGit;
  private readonly options: {
    now: () => number; timeZone: string; targetBytes?: number; fileLimitBytes?: number; ownerEmail?: string; ownerName?: string; backendEmail?: string;
  };
  private latest: { head: string; value: Promise<LastChanges> } | undefined;
  private tree: { head: string; value: Promise<Map<string, TreeEntry>> } | undefined;
  private links: { head: string; value: Promise<LinkCache> } | undefined;
  private readonly layerSizes = new Map<string, number>();

  constructor(dir: string, db: DatabaseSync, options: MemoryView["options"]) {
    this.git = new MemoryGit(dir);
    this.reports = new MemoryRecord(db);
    this.options = options;
  }

  head() { return this.git.head(); }

  async warmLastChanges(): Promise<void> {
    const head = await this.head();
    if (head) await this.lastChanges(head);
  }

  private ownerAuthor() {
    const { ownerEmail, ownerName } = this.options;
    return ownerEmail ? { email: ownerEmail, name: ownerName ?? "Owner" } : undefined;
  }

  private fileLimit() { return this.options.fileLimitBytes ?? DEFAULT_FILE_LIMIT; }

  private editLimit(path: string) { return LAYER.has(path) ? Math.min(this.fileLimit(), MEMORY_TEXT_BYTES) : MEMORY_TEXT_BYTES; }

  /** Called inside the commit queue, before inspecting or writing the work tree. */
  async planSave({ path, base_head, text }: MemorySaveRequest): Promise<SavePlan | MemorySaveResponse> {
    const author = this.ownerAuthor();
    if (!author) return { kind: "editing_disabled" };
    this.checkPath(path);
    if (path.startsWith("avatar/")) return { kind: "file_not_editable" };
    const head = await this.head();
    if (!head) return { kind: "file_not_editable" };
    await this.requireVersions(head, base_head);
    const old = (await this.filesAt(base_head)).get(path);
    if (!old || old.bytes > MEMORY_TEXT_BYTES) return { kind: "file_not_editable" };
    const original = await this.blob(old);
    if (textOf(original) === undefined) return { kind: "file_not_editable" };
    const file = (await this.filesAt(head)).get(path);
    if (!file || file.id !== old.id || file.mode !== old.mode) {
      const last = (await this.pathChanges(head, path))[0];
      const last_change = last ? { id: last.id, at: last.at, writer: this.activity().writer(last) } : null;
      return { kind: "head_conflict", head, exists: file !== undefined, last_change, diff: await this.fileDiff(path, path, old.id, file?.id) };
    }
    const body = Buffer.from(text, "utf8");
    if (body.length > MEMORY_TEXT_BYTES) return { kind: "text_too_large", max_bytes: MEMORY_TEXT_BYTES };
    if (body.length > this.editLimit(path)) return { kind: "prompt_file_limit", max_bytes: this.fileLimit() };
    return { kind: "write", head, file, original, body, author };
  }

  async overview(tz?: string): Promise<MemoryOverviewResponse> {
    const zone = this.zone(tz);
    const head = await this.head();
    const target = this.options.targetBytes ?? 16384;
    const can_edit = this.ownerAuthor() !== undefined;
    const empty = { bytes: 0, target_bytes: target, file_limit_bytes: this.fileLimit(), over_target_nights: [] as string[] };
    if (!head) return { head: null, can_edit, files: [], always_read: empty, broken_links: [], links_incomplete: false, last_night: null };
    const activity = this.activity();
    const reads = this.readCounts();
    const last = activity.nights[0];
    const [files, { paths }, overTarget, lastNight] = await Promise.all([
      this.filesAt(head), this.lastChanges(head), this.overTarget(head, activity.nights, target, zone),
      last ? this.night(last, head, activity) : null,
    ]);
    const links = await this.broken(head, files);
    return {
      head, can_edit,
      files: [...files].map(([path, file]) => this.fileInfo(path, file, paths.get(path), reads, activity)),
      always_read: {
        ...empty, bytes: [...LAYER].reduce((sum, path) => sum + (files.get(path)?.bytes ?? 0), 0), over_target_nights: overTarget,
      },
      broken_links: links.broken, links_incomplete: links.incomplete, last_night: lastNight,
    };
  }

  async file(path: string, head?: string): Promise<MemoryFileResponse> {
    this.checkPath(path);
    const { version, file } = await this.findFile(path, head);
    const activity = this.activity();
    const reads = this.readCounts();
    const last = activity.nights[0];
    const history = this.pathChanges(version, path);
    const [changes, links, movedFrom] = await Promise.all([
      history, /\.md$/i.test(path) ? this.filesAt(version).then((files) => this.broken(version, files)) : null,
      last ? this.movedFrom(last, version, path, history, activity) : undefined,
    ]);
    const broken_links = links?.broken.filter((link) => link.path === path) ?? [];
    const metadata = {
      head: version, file: this.fileInfo(path, file, changes[0], reads, activity), history_count: changes.length,
      broken_links, ...(movedFrom ? { moved_from: movedFrom } : {}),
    };
    if (path.startsWith("avatar/")) {
      if (file.bytes <= IMAGE_BYTES && imageTypeOf(await this.blob(file))) {
        const query = new URLSearchParams({ path, head: version });
        return { ...metadata, edit: null, kind: "image", image_url: `/api/memory/image?${query}` };
      }
      return { ...metadata, edit: null, kind: "unavailable" };
    }
    const text = file.bytes > MEMORY_TEXT_BYTES ? undefined : textOf(await this.blob(file));
    return text === undefined ? { ...metadata, edit: null, kind: "unavailable" } : {
      ...metadata, kind: /\.md$/i.test(path) ? "markdown" : "text", text,
      edit: this.ownerAuthor() ? { max_bytes: this.editLimit(path) } : null,
    };
  }

  async image(path: string, head?: string): Promise<{ bytes: Buffer; mime: string }> {
    this.checkPath(path);
    const { file } = await this.findFile(path, head);
    if (!path.startsWith("avatar/") || file.bytes > IMAGE_BYTES) throw new HttpError(404, "no such memory image");
    const bytes = await this.blob(file);
    const mime = imageTypeOf(bytes);
    if (!mime) throw new HttpError(404, "no such memory image");
    return { bytes, mime };
  }

  async changes({ head, before, tz, writer = "all" }: { head?: string; before?: string; tz?: string; writer?: MemoryWriterFilter }): Promise<MemoryChangesResponse> {
    const zone = this.zone(tz);
    if (!["all", "daytime", "night", "owner"].includes(writer)) throw new HttpError(400, "invalid memory writer filter");
    const version = await this.version(head);
    if (!version) return { head: null, days: [] };
    const activity = this.activity();
    // Imported histories need not have monotonic committer dates. Sort only
    // commit headers, keeping first-parent order for equal timestamps.
    const ordered = (await this.git.commits(version)).filter((entry) => {
      if (writer === "all") return true;
      const kind = activity.writer(entry, false).kind;
      return kind === writer || (writer === "night" && entry.repair !== undefined);
    }).sort((a, b) => b.at.localeCompare(a.at));
    const start = pageStart(ordered, before);
    if (before !== undefined && !(await this.git.selected([before], "paths"))[0]?.files.length) {
      throw new HttpError(400, "invalid memory page cursor");
    }
    const page: GitCommit[] = [];
    for (let i = start; i < ordered.length && page.length <= PAGE; i += PAGE + 1) {
      const ids = ordered.slice(i, i + PAGE + 1).map(({ id }) => id);
      for (const { files, ...commit } of await this.git.selected(ids, "paths")) if (files.length) page.push(commit);
    }
    const next = page.length > PAGE ? page[PAGE - 1]!.id : undefined;
    const onPage = page.slice(0, PAGE);
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    const dayOfCommit = ({ at }: GitCommit) => formatter.format(Date.parse(at));
    const groups = new Map(onPage.map((entry) => [dayOfCommit(entry), { changes: 0, paths: new Set<string>(), items: [] as MemoryChange[] }]));
    const shown = new Set(onPage.map(({ id }) => id));
    // Daily totals include the whole filtered day, with only the destination
    // of a move. Off-page commits need rename detection but no line counts.
    const offPage = groups.size ? ordered.filter((entry) => !shown.has(entry.id) && groups.has(dayOfCommit(entry))) : [];
    const [detailed, totals] = await Promise.all([
      this.git.selected([...shown], "counts"), this.git.selected(offPage.map(({ id }) => id), "moves"),
    ]);
    for (const entry of detailed) groups.get(dayOfCommit(entry))!.items.push(this.summary(entry, activity));
    for (const entry of [...detailed, ...totals]) if (entry.files.length) {
      const group = groups.get(dayOfCommit(entry))!;
      group.changes++;
      for (const { path } of entry.files) group.paths.add(path);
    }
    const days = [...groups].map(([day, { changes, paths, items }]) => ({ day, changes, files: paths.size, items }));
    return { head: version, days, ...(next === undefined ? {} : { next }) };
  }

  async change(id: string): Promise<MemoryChangeResponse> {
    const entry = await this.findChange(id);
    return this.detail(entry, this.activity());
  }

  async diff(id: string, path: string): Promise<MemoryFileDiff> {
    this.checkPath(path);
    const entry = await this.findChange(id, "moves");
    const file = entry.files.find((file) => file.path === path);
    if (!file) throw new HttpError(404, "no such changed file");
    return this.fileDiff(path, file.from ?? path, file.oldBlob, file.newBlob);
  }

  async history(path: string, { head, before }: { head?: string; before?: string } = {}): Promise<MemoryHistoryResponse> {
    this.checkPath(path);
    const version = await this.version(head);
    if (!version) return { head: null, changes: [] };
    const entries = await this.pathChanges(version, path);
    const start = pageStart(entries, before);
    const page = await this.git.selected(entries.slice(start, start + PAGE).map(({ id }) => id), "counts");
    const next = start + PAGE < entries.length ? page.at(-1)!.id : undefined;
    const activity = this.activity();
    return { head: version, changes: page.map((entry) => this.summary(entry, activity)), ...(next === undefined ? {} : { next }) };
  }

  async compare(path: string, from: string, to: string): Promise<MemoryCompareResponse> {
    this.checkPath(path);
    const positions = await this.requireVersions(await this.head(), from, to);
    if (positions.indexOf(from) <= positions.indexOf(to)) throw new HttpError(400, "from must be older than to");
    const [history, older] = await Promise.all([this.pathChanges(to, path, from), this.git.selected([from], "paths")]);
    if (history[0]?.id !== to || !older[0]?.files.some((file) => file.path === path)) throw new HttpError(404, "no such version of this path");
    const changes = history.length;
    const [left, right, counts] = await Promise.all([this.git.tree(from, [path]), this.git.tree(to, [path]), this.git.diffCounts(from, to, path)]);
    const diff = await this.fileDiff(path, path, left.get(path)?.id, right.get(path)?.id);
    return { from, to, changes, ...counts, diff };
  }

  async search(query: string, head?: string): Promise<MemorySearchResponse> {
    if (!query || /[\r\n\0]/.test(query) || Buffer.byteLength(query) > 512) throw new HttpError(400, "q must be a single nonempty line of up to 512 bytes");
    const version = await this.version(head);
    const result: MemorySearchResponse = { head: version, files: [], truncated: false, line_limit: SEARCH_LINES };
    if (!version) return result;
    const tree = await this.filesAt(version);
    const { bytes, truncated } = await this.git.grep(version, query, SEARCH_LINES);
    result.truncated = truncated;
    const files = new Map<string, MemorySearchResponse["files"][number]>();
    let count = 0;
    // A filename can contain newlines or colons. Only the match text ends at LF.
    for (let start = 0; start < bytes.length;) {
      const nameEnd = bytes.indexOf(0, start);
      const lineEnd = nameEnd < 0 ? -1 : bytes.indexOf(0, nameEnd + 1);
      const textEnd = lineEnd < 0 ? -1 : bytes.indexOf(10, lineEnd + 1);
      if (nameEnd < 0 || lineEnd < 0 || textEnd < 0) break;
      const path = bytes.toString("utf8", start + version.length + 1, nameEnd);
      start = textEnd + 1;
      if (!tree.has(path) || path.startsWith("avatar/")) continue;
      if (count === SEARCH_LINES) { result.truncated = true; break; }
      count++;
      let file = files.get(path);
      if (!file) { file = { path, lines: [] }; files.set(path, file); }
      file.lines.push({ line: Number(bytes.toString("ascii", nameEnd + 1, lineEnd)), text: bytes.toString("utf8", lineEnd + 1, textEnd).replace(/\r$/, "") });
    }
    result.files = [...files.values()];
    return result;
  }

  async turnChange(id: string): Promise<MemoryChange | undefined> {
    const head = await this.head();
    if (!head || /[\0\n]/.test(id)) return undefined;
    const candidates = (await this.git.commits(head, [`Turn ${id}`])).filter(({ turn }) => turn?.id === id);
    const found = (await this.git.selected(candidates.map(({ id }) => id), "paths")).find(({ files }) => files.length);
    if (!found) return undefined;
    const [entry] = await this.git.selected([found.id], "counts");
    return entry && this.summary(entry, this.activity());
  }

  async nightChanges(id: string): Promise<MemoryChange[]> {
    const head = await this.head();
    if (!head) return [];
    const activity = this.activity();
    const night = activity.nights.find((night) => night.id === id);
    return night ? (await this.nightEntries(night, head, activity)).map((entry) => this.summary(entry, activity)) : [];
  }

  private lastChanges(head: string): Promise<LastChanges> {
    if (this.latest?.head !== head) {
      const before = this.latest?.value;
      const value = this.loadLastChanges(head, before);
      this.latest = { head, value };
      void value.catch(() => { if (this.latest?.value === value) this.latest = undefined; });
    }
    return this.latest.value;
  }

  private async loadLastChanges(head: string, before: Promise<LastChanges> | undefined): Promise<LastChanges> {
    const previous = await before?.catch(() => undefined);
    let entries = await this.git.paths(head, previous ? { after: previous.head } : {});
    const paths = new Map<string, GitCommit>();
    // A rewound or switched HEAD can only reuse a true first-parent suffix.
    const reuse = previous && entries.at(-1)?.parent === previous.head;
    if (previous && !reuse) entries = await this.git.paths(head);
    const seen = new Set<string>();
    for (const { files, ...commit } of entries) {
      for (const { path, newBlob } of files) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (newBlob) paths.set(path, commit);
      }
    }
    if (reuse) for (const [path, commit] of previous.paths) if (!seen.has(path)) paths.set(path, commit);
    return { head, paths };
  }

  private async pathChanges(head: string, path: string, after?: string): Promise<GitChange[]> {
    const changes = await this.git.paths(head, { path, ...(after === undefined ? {} : { after }) });
    return changes.filter(({ files }) => files.some((file) => file.path === path));
  }

  private filesAt(head: string): Promise<Map<string, TreeEntry>> {
    if (this.tree?.head !== head) {
      const value = this.git.tree(head);
      this.tree = { head, value };
      void value.catch(() => { if (this.tree?.value === value) this.tree = undefined; });
    }
    return this.tree.value;
  }

  private broken(head: string, files: Map<string, TreeFile>): Promise<LinkCache> {
    if (this.links?.head !== head) {
      const before = this.links?.value;
      const value = this.checkLinks(head, files, before);
      this.links = { head, value };
      void value.catch(() => { if (this.links?.value === value) this.links = undefined; });
    }
    return this.links.value;
  }

  private async checkLinks(head: string, files: Map<string, TreeFile>, before: Promise<LinkCache> | undefined): Promise<LinkCache> {
    const previous = await before?.catch(() => undefined);
    const links = new Map<string, LocalLink[]>();
    const paths = new Set(files.keys());
    const scans: Array<[string, TreeFile]> = [];
    const pending = new Map<string, TreeFile>();
    let incomplete = false;
    let bytes = 0;
    for (const [path, file] of files) {
      for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) paths.add(path.slice(0, i));
      if (!/\.md$/i.test(path) || path.startsWith("avatar/")) continue;
      const key = `${file.id}:${path}`;
      const cached = previous?.links.get(key);
      if (file.bytes > MEMORY_TEXT_BYTES || bytes + file.bytes > LINK_BYTES) { incomplete = true; continue; }
      bytes += file.bytes;
      if (cached) links.set(key, cached);
      else {
        scans.push([path, file]);
        pending.set(file.id, file);
      }
    }
    const blobs = await this.git.blobs([...pending.values()]);
    for (const [path, file] of scans) {
      const text = textOf(blobs.get(file.id)!);
      links.set(`${file.id}:${path}`, text === undefined ? [] : localLinks(path, text));
    }
    const broken: MemoryBrokenLink[] = [];
    for (const [path, { id }] of files) {
      for (const { target, line, destination } of links.get(`${id}:${path}`) ?? []) {
        if (target === "." || paths.has(target)) continue;
        if (broken.length < LINK_RESULTS) broken.push({ path, line, destination });
        else incomplete = true;
      }
    }
    return { head, links, broken, incomplete };
  }

  private activity() {
    const nights = this.reports.nights();
    const nightById = new Map(nights.map((night) => [night.id, night]));
    const nightBySeq = new Map(nights.map((night) => [night.seq, night]));
    const turns = this.reports.nightTurns();
    const writer = (entry: GitCommit, includeTrigger = true): MemoryWriter => {
      const night_seq = entry.nightSeq;
      const marked = night_seq === undefined ? undefined : nightBySeq.get(night_seq);
      const sequence = night_seq === undefined ? {} : { night_seq };
      if (entry.avatarSeed) return { kind: "system", operation: "avatar_seed" };
      if (entry.repair) {
        const turn = entry.repair.turn;
        const night_id = marked?.id;
        return { kind: "system", operation: "reference_repair", ...sequence, ...(night_id ? { night_id } : {}),
          ...(turn && turns.get(turn)?.night_id === night_id && turns.has(turn) ? { turn_id: turn } : {}) };
      }
      const turn = entry.turn;
      if (turn) {
        const night = turn.agent === "main" ? turns.get(turn.id) : undefined;
        const night_id = entry.nightSeq === undefined ? night?.night_id : marked?.id;
        const stage = turn.stage ?? night?.stage;
        if (stage) {
          const phase = stage === "curator" && night_id ? nightById.get(night_id)?.phases.get(turn.id) : undefined;
          return { kind: "night", stage: phase ?? stage, ...sequence, ...(night ? { turn_id: turn.id } : {}), ...(night_id ? { night_id } : {}) };
        }
        const record = includeTrigger ? this.reports.trigger(turn.id, turn.agent) : undefined;
        return { kind: "daytime", agent: turn.agent, ...(record ? { turn_id: turn.id, ...record } : {}) };
      }
      const { ownerEmail, ownerName, backendEmail } = this.options;
      const owner = (ownerEmail !== undefined || ownerName !== undefined) && (entry.email !== backendEmail || entry.ownerSave === true) &&
        (ownerEmail === undefined || ownerEmail === entry.email) && (ownerName === undefined || ownerName === entry.author);
      return { kind: owner ? "owner" : "unknown" };
    };
    return { nights, turns, writer };
  }

  private async nightCommits(night: MemoryRecordNight, head: string, activity: ReturnType<MemoryView["activity"]>): Promise<GitCommit[]> {
    const markers = night.seq === null ? [] : [`Night: ${night.seq}`];
    for (const [id, turn] of activity.turns) {
      if (turn.night_id === night.id && !/[\0\n]/.test(id)) markers.push(`Turn ${id}`);
    }
    if (!markers.length) return [];
    return (await this.git.commits(head, markers)).filter((entry) => {
      if (!entry.turn && !entry.repair) return false;
      const writer = activity.writer(entry, false);
      return (writer.kind === "night" || writer.kind === "system") && writer.night_id === night.id;
    }).reverse();
  }

  private async nightEntries(night: MemoryRecordNight, head: string, activity: ReturnType<MemoryView["activity"]>): Promise<GitChange[]> {
    const commits = await this.nightCommits(night, head, activity);
    const visible = (await this.git.selected(commits.map(({ id }) => id), "paths")).filter(({ files }) => files.length);
    return this.git.selected(visible.map(({ id }) => id), "counts");
  }

  private async movedFrom(night: MemoryRecordNight, head: string, path: string, history: Promise<GitChange[]>, activity: ReturnType<MemoryView["activity"]>) {
    const [commits, changes] = await Promise.all([this.nightCommits(night, head, activity), history]);
    const touched = new Set(changes.map(({ id }) => id));
    const candidates = commits.filter(({ id, repair }) => repair ? repair.moves.some(({ to }) => to === path) : touched.has(id));
    const entries = await this.git.selected(candidates.map(({ id }) => id), "moves");
    return entries.filter(({ files }) => files.length).flatMap((entry) => this.moves(entry)).findLast(({ to }) => to === path)?.from;
  }

  private async night(night: MemoryRecordNight, head: string, activity: ReturnType<MemoryView["activity"]>): Promise<MemoryNight> {
    const changes = (await this.nightEntries(night, head, activity)).map((entry) => this.detail(entry, activity));
    const counts = changes.reduce((sum, { change }) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 });
    return { id: night.id, at: night.at, ended_at: night.ended_at, ...counts, files: new Set(changes.flatMap(({ change }) => change.paths)).size, changes };
  }

  private async overTarget(head: string, nights: MemoryRecordNight[], target: number, zone: string): Promise<string[]> {
    if (!nights.some((night) => night.head !== "")) return [];
    const legacy = nights.some((night) => night.head === null);
    const commits = legacy ? await this.git.commits(head) : [];
    const reachable = new Set(legacy ? commits.map(({ id }) => id) : await this.git.firstParent(head));
    const ordered = commits.sort((a, b) => b.at.localeCompare(a.at));
    let cursor = 0;
    const versions = nights.flatMap((night) => {
      if (night.head === null) while (ordered[cursor] && ordered[cursor]!.at > night.ended_at) cursor++;
      const version = night.head ?? ordered[cursor]?.id;
      return version && reachable.has(version) ? [{ night, version }] : [];
    });
    const missing = [...new Set(versions.map(({ version }) => version))].filter((id) => !this.layerSizes.has(id));
    // Look at the prompt files in each end-of-night tree, not in the commits between nights.
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map(async (id) => {
        const tree = await this.git.tree(id, [...LAYER]);
        this.layerSizes.set(id, [...LAYER].reduce((sum, path) => sum + (tree.get(path)?.bytes ?? 0), 0));
      }));
    }
    return [...new Set(versions.filter(({ version }) => this.layerSizes.get(version)! > target).map(({ night }) => dayOf(Date.parse(night.at), zone)))];
  }

  private readCounts(): Map<string, MemoryReadCount> | null {
    const reads = this.reports.reads();
    if (!reads) return null;
    const today = new Date(this.options.now()).toISOString().slice(0, 10);
    const cutoff = new Date(Date.parse(today) - 29 * DAY_MS).toISOString().slice(0, 10);
    return new Map(reads.files.map(({ path, dates }) => {
      let last: string | null = null;
      let count = 0;
      for (const date of dates) {
        if (last === null || date > last) last = date;
        if (date >= cutoff && date <= today) count++;
      }
      return [path, { count_30_days: count, last_day: last }];
    }));
  }

  private fileInfo(path: string, file: TreeFile, last: GitCommit | undefined, reads: Map<string, MemoryReadCount> | null, activity: ReturnType<MemoryView["activity"]>): MemoryFile {
    return { path, bytes: file.bytes, always_read: LAYER.has(path),
      reads: reads === null ? null : reads.get(path) ?? { count_30_days: 0, last_day: null },
      last_change: last ? { id: last.id, at: last.at, writer: activity.writer(last) } : null };
  }

  private summary(entry: GitChange, activity: ReturnType<MemoryView["activity"]>): MemoryChange {
    const counts = entry.files.reduce<MemoryCounts>((sum, file) => ({ files: sum.files + 1, added: sum.added + file.added, removed: sum.removed + file.removed }), { files: 0, added: 0, removed: 0 });
    return { id: entry.id, at: entry.at, writer: activity.writer(entry), paths: entry.files.map(({ path }) => path), ...counts };
  }

  private moves(entry: GitChange) {
    return entry.repair?.moves ?? entry.files.flatMap(({ path, from }) => from === undefined ? [] : [{ from, to: path }]);
  }

  private detail(entry: GitChange, activity: ReturnType<MemoryView["activity"]>): MemoryChangeResponse {
    const files: MemoryFileChange[] = entry.files.map(({ path, from, kind, added, removed }) => ({ path, ...(from === undefined ? {} : { from }), kind, added, removed }));
    return { change: this.summary(entry, activity), files, moves: this.moves(entry) };
  }

  private zone(tz?: string): string {
    const zone = tz ?? this.options.timeZone;
    if (!isTimeZone(zone)) throw new HttpError(400, "tz must be an IANA time zone");
    return zone;
  }

  private async version(requested?: string): Promise<string | null> {
    const current = await this.head();
    if (requested === undefined) return current;
    await this.requireVersions(current, requested);
    return requested;
  }

  private checkPath(path: string) {
    if (!memoryPath(path)) throw new HttpError(400, "path must be a memory-relative file name");
  }

  private async requireVersions(head: string | null, ...ids: string[]): Promise<string[]> {
    let commits = head === null ? [] : ids.every((id) => id === head) ? [head] : undefined;
    for (const id of ids) {
      if (!OBJECT_ID.test(id)) throw new HttpError(400, "invalid memory change id");
      commits ??= await this.git.firstParent(head!);
      if (!commits.includes(id)) throw new HttpError(404, "no such memory change");
    }
    return commits ?? [];
  }

  private async findChange(id: string, mode: "moves" | "counts" = "counts"): Promise<GitChange> {
    await this.requireVersions(await this.head(), id);
    return (await this.git.selected([id], mode))[0]!;
  }

  private async findFile(path: string, head?: string) {
    const version = await this.version(head);
    const file = version ? (await this.filesAt(version)).get(path) : undefined;
    if (!version || !file) throw new HttpError(404, "no such memory file");
    return { version, file };
  }

  private async blob(file: TreeFile): Promise<Buffer> { return (await this.git.blobs([file])).get(file.id)!; }

  private async fileDiff(path: string, oldPath: string, from?: string, to?: string): Promise<MemoryFileDiff> {
    const ids = [...new Set([from, to].filter((id) => id !== undefined))];
    const sizes = await this.git.sizes(ids);
    const avatar = path.startsWith("avatar/") || oldPath.startsWith("avatar/");
    if (ids.some((id) => (sizes.get(id) ?? Infinity) > (avatar ? IMAGE_BYTES : MEMORY_TEXT_BYTES))) return { kind: "too_large" };
    const blobs = await this.git.blobs(ids.map((id) => ({ id, bytes: sizes.get(id)! })));
    if (avatar) return { kind: ids.some((id) => imageTypeOf(blobs.get(id)!)) ? "image" : "binary" };
    const left = from ? textOf(blobs.get(from)!) : "";
    const right = to ? textOf(blobs.get(to)!) : "";
    if (left === undefined || right === undefined) return { kind: "binary" };
    if (!from || !to) {
      const lines = (from ? left : right).split("\n");
      if (lines.at(-1) === "") lines.pop();
      return { kind: "text", truncated: lines.length > DIFF_LINES, hunks: lines.length ? [{ old_start: from ? 1 : 0, new_start: to ? 1 : 0,
        lines: lines.slice(0, DIFF_LINES).map((text, i) => from ? { kind: "removed", old_line: i + 1, text } : { kind: "added", new_line: i + 1, text }) }] : [] };
    }
    if (from === to) return { kind: "text", hunks: [], truncated: false };
    const patch = await this.git.patch(from, to);
    return parsePatch(patch.bytes.toString(), patch.truncated);
  }
}

function textOf(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}

function pageStart(entries: { id: string }[], before: string | undefined): number {
  if (before === undefined) return 0;
  const start = entries.findIndex(({ id }) => id === before) + 1;
  if (start === 0) throw new HttpError(400, "invalid memory page cursor");
  return start;
}

function parsePatch(patch: string, truncated: boolean): MemoryFileDiff {
  const hunks: Extract<MemoryFileDiff, { kind: "text" }>["hunks"] = [];
  let old = 0, next = 0, count = 0;
  for (let start = 0, end = patch.indexOf("\n"); end !== -1; start = end + 1, end = patch.indexOf("\n", start)) {
    const line = patch.slice(start, end);
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      old = Number(header[1]); next = Number(header[2]);
      hunks.push({ old_start: old, new_start: next, lines: [] });
    } else {
      const hunk = hunks.at(-1);
      if (!hunk || !/^[ +\-]/.test(line)) continue;
      if (++count > DIFF_LINES) return { kind: "text", hunks: hunks.filter((hunk) => hunk.lines.length), truncated: true };
      const text = line.slice(1);
      if (line.startsWith(" ")) hunk.lines.push({ kind: "context", old_line: old++, new_line: next++, text });
      else if (line.startsWith("+")) hunk.lines.push({ kind: "added", new_line: next++, text });
      else if (line.startsWith("-")) hunk.lines.push({ kind: "removed", old_line: old++, text });
    }
  }
  return { kind: "text", hunks: hunks.filter((hunk) => hunk.lines.length), truncated };
}
