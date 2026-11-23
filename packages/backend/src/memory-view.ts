import type { DatabaseSync } from "node:sqlite";

import type {
  MemoryBrokenLink, MemoryChange, MemoryChangeResponse, MemoryChangesResponse, MemoryCompareResponse, MemoryCounts,
  MemoryFile, MemoryFileChange, MemoryFileDiff, MemoryFileResponse, MemoryHistoryResponse, MemoryNight,
  MemoryOverviewResponse, MemoryReadCount, MemorySaveRequest, MemorySaveResponse, MemorySearchResponse, MemoryWriter, MemoryWriterFilter,
} from "@penelope/contract";

import { HttpError } from "./http.ts";
import { type GitChange, MemoryGit, memoryPath, OBJECT_ID, type TreeEntry, type TreeFile } from "./memory-git.ts";
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

type Entry = GitChange & { order: number };
type Index = { head: string; entries: Entry[]; byId: Map<string, Entry>; byTurn: Map<string, Entry>; byPath: Map<string, Entry[]> };
type LinkCache = { head: string; links: Map<string, LocalLink[]>; broken: MemoryBrokenLink[]; incomplete: boolean };
type SavePlan = { kind: "write"; head: string; file: TreeEntry; original: Buffer; body: Buffer; author: { name: string; email: string } };

export class MemoryView {
  readonly reports: MemoryRecord;
  private readonly git: MemoryGit;
  private readonly options: {
    now: () => number; timeZone: string; targetBytes?: number; fileLimitBytes?: number; ownerEmail?: string; ownerName?: string; backendEmail?: string;
  };
  private indexed: { head: string; value: Promise<Index> } | undefined;
  private tree: { head: string; value: Promise<Map<string, TreeEntry>> } | undefined;
  private links: { head: string; value: Promise<LinkCache> } | undefined;
  private readonly layerSizes = new Map<string, number>();

  constructor(dir: string, db: DatabaseSync, options: MemoryView["options"]) {
    this.git = new MemoryGit(dir);
    this.reports = new MemoryRecord(db);
    this.options = options;
  }

  head() { return this.git.head(); }

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
    const index = await this.index();
    if (!index) return { kind: "file_not_editable" };
    const base = this.entry(index, base_head);
    const old = (await this.filesAt(base.id)).get(path);
    if (!old || old.bytes > MEMORY_TEXT_BYTES) return { kind: "file_not_editable" };
    const original = await this.blob(old);
    if (textOf(original) === undefined) return { kind: "file_not_editable" };
    const { head } = index;
    const file = (await this.filesAt(head)).get(path);
    if (!file || file.id !== old.id || file.mode !== old.mode) {
      const last = index.byPath.get(path)?.[0];
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
    const index = await this.index();
    const target = this.options.targetBytes ?? 16384;
    const can_edit = this.ownerAuthor() !== undefined;
    const empty = { bytes: 0, target_bytes: target, file_limit_bytes: this.fileLimit(), over_target_nights: [] as string[] };
    if (!index) return { head: null, can_edit, files: [], always_read: empty, broken_links: [], links_incomplete: false, last_night: null };
    const files = await this.filesAt(index.head);
    const activity = this.activity();
    const reads = this.readCounts();
    const [links, overTarget] = await Promise.all([this.broken(index.head, files), this.overTarget(index, activity.nights, target, zone)]);
    const last = activity.nights[0];
    return {
      head: index.head, can_edit,
      files: [...files].map(([path, file]) => this.fileInfo(path, file, index.byPath.get(path)?.[0], reads, activity)),
      always_read: {
        ...empty, bytes: [...LAYER].reduce((sum, path) => sum + (files.get(path)?.bytes ?? 0), 0), over_target_nights: overTarget,
      },
      broken_links: links.broken, links_incomplete: links.incomplete, last_night: last ? this.night(last, index, activity) : null,
    };
  }

  async file(path: string, head?: string): Promise<MemoryFileResponse> {
    this.checkPath(path);
    const { index, version, file } = await this.findFile(path, head);
    const activity = this.activity();
    const history = this.fileHistory(index, version, path);
    const reads = this.readCounts();
    const broken_links = /\.md$/i.test(path)
      ? (await this.broken(version, await this.filesAt(version))).broken.filter((link) => link.path === path) : [];
    const last = activity.nights[0];
    const movedFrom = last && this.night(last, index, activity, version).changes.flatMap(({ moves }) => moves)
      .findLast(({ to }) => to === path)?.from;
    const metadata = {
      head: version, file: this.fileInfo(path, file, history[0], reads, activity), history_count: history.length,
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
    const index = await this.index();
    const version = this.version(index, head);
    if (!index || !version) return { head: null, days: [] };
    const activity = this.activity();
    const position = index.byId.get(version)!.order;
    const entries = index.entries.slice(position).filter((entry) => {
      if (!entry.files.length) return false;
      if (writer === "all") return true;
      const kind = activity.writer(entry, false).kind;
      return kind === writer || (writer === "night" && entry.repair !== undefined);
    }).sort((a, b) => b.at.localeCompare(a.at) || a.order - b.order);
    const { page, next } = pageOf(entries, before);
    const groups = new Map<string, MemoryChangesResponse["days"][number]>();
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    const day = (entry: Entry) => formatter.format(Date.parse(entry.at));
    for (const entry of page) {
      const key = day(entry);
      if (!groups.has(key)) groups.set(key, { day: key, changes: 0, files: 0, items: [] });
      groups.get(key)!.items.push(this.summary(entry, activity));
    }
    const paths = new Map([...groups.keys()].map((key) => [key, new Set<string>()]));
    for (const entry of entries) {
      const key = day(entry);
      const group = groups.get(key);
      if (!group) continue;
      group.changes++;
      for (const { path } of entry.files) paths.get(key)!.add(path);
    }
    for (const [key, group] of groups) group.files = paths.get(key)!.size;
    return { head: version, days: [...groups.values()], ...(next === undefined ? {} : { next }) };
  }

  async change(id: string): Promise<MemoryChangeResponse> {
    const entry = await this.findChange(id);
    return this.detail(entry, this.activity());
  }

  async diff(id: string, path: string): Promise<MemoryFileDiff> {
    this.checkPath(path);
    const entry = await this.findChange(id);
    const file = entry.files.find((file) => file.path === path);
    if (!file) throw new HttpError(404, "no such changed file");
    return this.fileDiff(path, file.from ?? path, file.oldBlob, file.newBlob);
  }

  async history(path: string, { head, before }: { head?: string; before?: string } = {}): Promise<MemoryHistoryResponse> {
    this.checkPath(path);
    const index = await this.index();
    const version = this.version(index, head);
    if (!index || !version) return { head: null, changes: [] };
    const { page, next } = pageOf(this.fileHistory(index, version, path), before);
    const activity = this.activity();
    return { head: version, changes: page.map((entry) => this.summary(entry, activity)), ...(next === undefined ? {} : { next }) };
  }

  async compare(path: string, from: string, to: string): Promise<MemoryCompareResponse> {
    this.checkPath(path);
    const index = await this.index();
    const old = this.entry(index, from);
    const current = this.entry(index, to);
    if (old.order <= current.order) throw new HttpError(400, "from must be older than to");
    const history = this.fileHistory(index!, to, path);
    if (!history.some(({ id }) => id === to) || !history.some(({ id }) => id === from)) throw new HttpError(404, "no such version of this path");
    const changes = history.filter(({ order }) => order >= current.order && order < old.order).length;
    const [left, right, counts] = await Promise.all([this.git.tree(from), this.git.tree(to), this.git.diffCounts(from, to, path)]);
    const diff = await this.fileDiff(path, path, left.get(path)?.id, right.get(path)?.id);
    return { from, to, changes, ...counts, diff };
  }

  async search(query: string, head?: string): Promise<MemorySearchResponse> {
    if (!query || /[\r\n\0]/.test(query) || Buffer.byteLength(query) > 512) throw new HttpError(400, "q must be a single nonempty line of up to 512 bytes");
    const index = await this.index();
    const version = this.version(index, head);
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
    const entry = (await this.index())?.byTurn.get(id);
    return entry ? this.summary(entry, this.activity()) : undefined;
  }

  async nightChanges(id: string): Promise<MemoryChange[]> {
    const index = await this.index();
    if (!index) return [];
    const activity = this.activity();
    const night = activity.nights.find((night) => night.id === id);
    return night ? this.nightEntries(night, index, activity).map((entry) => this.summary(entry, activity)) : [];
  }

  private async index(): Promise<Index | undefined> {
    const head = await this.git.head();
    if (head === null) return undefined;
    if (this.indexed?.head !== head) {
      const before = this.indexed?.value;
      const value = this.loadIndex(head, before);
      this.indexed = { head, value };
      void value.catch(() => { if (this.indexed?.value === value) this.indexed = undefined; });
    }
    return this.indexed.value;
  }

  private async loadIndex(head: string, before: Promise<Index> | undefined): Promise<Index> {
    const previous = await before?.catch(() => undefined);
    let entries: GitChange[];
    if (previous) {
      const newEntries = await this.git.changes(head, previous.head);
      // After a branch switch, rewind or imported merge, only reuse a true
      // first-parent suffix. The previously published index stays immutable.
      entries = newEntries.at(-1)?.parent === previous.head ? [...newEntries, ...previous.entries] : await this.git.changes(head);
    } else entries = await this.git.changes(head);
    const byId = new Map<string, Entry>();
    const byTurn = new Map<string, Entry>();
    const byPath = new Map<string, Entry[]>();
    const indexed = entries.map((change, order) => {
      const entry = { ...change, order };
      byId.set(entry.id, entry);
      if (entry.turn && entry.files.length && !byTurn.has(entry.turn.id)) byTurn.set(entry.turn.id, entry);
      const paths = new Set(entry.files.flatMap(({ path, from }) => from === undefined ? [path] : [path, from]));
      for (const path of paths) {
        const list = byPath.get(path);
        if (list) list.push(entry);
        else byPath.set(path, [entry]);
      }
      return entry;
    });
    return { head, entries: indexed, byId, byTurn, byPath };
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
    const writer = (entry: Entry, includeTrigger = true): MemoryWriter => {
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
    return { nights, writer };
  }

  private nightEntries(night: MemoryRecordNight, index: Index, activity: ReturnType<MemoryView["activity"]>, version = index.head): Entry[] {
    const position = index.byId.get(version)!.order;
    return index.entries.slice(position).filter((entry) => {
      if (!entry.files.length || (!entry.turn && !entry.repair)) return false;
      const writer = activity.writer(entry, false);
      return (writer.kind === "night" || writer.kind === "system") && writer.night_id === night.id;
    }).reverse();
  }

  private night(night: MemoryRecordNight, index: Index, activity: ReturnType<MemoryView["activity"]>, version?: string): MemoryNight {
    const changes = this.nightEntries(night, index, activity, version).map((entry) => this.detail(entry, activity));
    const counts = changes.reduce((sum, { change }) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 });
    return { id: night.id, at: night.at, ended_at: night.ended_at, ...counts, files: new Set(changes.flatMap(({ change }) => change.paths)).size, changes };
  }

  private async overTarget(index: Index, nights: MemoryRecordNight[], target: number, zone: string): Promise<string[]> {
    const ordered = [...index.entries].sort((a, b) => b.at.localeCompare(a.at) || a.order - b.order);
    let cursor = 0;
    const sizes = nights.flatMap((night) => {
      const head = night.head === null ? (() => {
        while (ordered[cursor] && ordered[cursor]!.at > night.ended_at) cursor++;
        return ordered[cursor]?.id;
      })() : night.head;
      const commit = head ? index.byId.get(head) : undefined;
      if (!commit) return [];
      const blobs = [...LAYER].flatMap((path) => {
        const change = index.byPath.get(path)?.find(({ order }) => order >= commit.order)?.files.find((file) => file.path === path || file.from === path);
        return change?.path === path && change.newBlob ? [change.newBlob] : [];
      });
      return [{ date: dayOf(Date.parse(night.at), zone), blobs }];
    });
    const missing = [...new Set(sizes.flatMap(({ blobs }) => blobs))].filter((id) => !this.layerSizes.has(id));
    for (const [id, size] of await this.git.sizes(missing)) this.layerSizes.set(id, size);
    return [...new Set(sizes.filter(({ blobs }) => blobs.reduce((sum, id) => sum + (this.layerSizes.get(id) ?? 0), 0) > target).map(({ date }) => date))];
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

  private fileInfo(path: string, file: TreeFile, last: Entry | undefined, reads: Map<string, MemoryReadCount> | null, activity: ReturnType<MemoryView["activity"]>): MemoryFile {
    return { path, bytes: file.bytes, always_read: LAYER.has(path),
      reads: reads === null ? null : reads.get(path) ?? { count_30_days: 0, last_day: null },
      last_change: last ? { id: last.id, at: last.at, writer: activity.writer(last) } : null };
  }

  private summary(entry: Entry, activity: ReturnType<MemoryView["activity"]>): MemoryChange {
    const counts = entry.files.reduce<MemoryCounts>((sum, file) => ({ files: sum.files + 1, added: sum.added + file.added, removed: sum.removed + file.removed }), { files: 0, added: 0, removed: 0 });
    return { id: entry.id, at: entry.at, writer: activity.writer(entry), paths: entry.files.map(({ path }) => path), ...counts };
  }

  private detail(entry: Entry, activity: ReturnType<MemoryView["activity"]>): MemoryChangeResponse {
    const files: MemoryFileChange[] = entry.files.map(({ path, from, kind, added, removed }) => ({ path, ...(from === undefined ? {} : { from }), kind, added, removed }));
    const moves = entry.repair?.moves ?? files.flatMap(({ path, from }) => from === undefined ? [] : [{ from, to: path }]);
    return { change: this.summary(entry, activity), files, moves };
  }

  private fileHistory(index: Index, version: string, path: string): Entry[] {
    const position = index.byId.get(version)!.order;
    return index.byPath.get(path)?.filter(({ order }) => order >= position) ?? [];
  }

  private zone(tz?: string): string {
    const zone = tz ?? this.options.timeZone;
    if (!isTimeZone(zone)) throw new HttpError(400, "tz must be an IANA time zone");
    return zone;
  }

  private version(index: Index | undefined, head?: string): string | null {
    return head === undefined ? index?.head ?? null : this.entry(index, head).id;
  }

  private checkPath(path: string) {
    if (!memoryPath(path)) throw new HttpError(400, "path must be a memory-relative file name");
  }

  private entry(index: Index | undefined, id: string): Entry {
    if (!OBJECT_ID.test(id)) throw new HttpError(400, "invalid memory change id");
    const found = index?.byId.get(id);
    if (!found) throw new HttpError(404, "no such memory change");
    return found;
  }

  private async findChange(id: string): Promise<Entry> { return this.entry(await this.index(), id); }

  private async findFile(path: string, head?: string) {
    const index = await this.index();
    const version = this.version(index, head);
    const file = version ? (await this.filesAt(version)).get(path) : undefined;
    if (!index || !version || !file) throw new HttpError(404, "no such memory file");
    return { index, version, file };
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

function pageOf(entries: Entry[], before: string | undefined) {
  const i = before === undefined ? 0 : entries.findIndex(({ id }) => id === before) + 1;
  if (before !== undefined && i === 0) throw new HttpError(400, "invalid memory page cursor");
  const page = entries.slice(i, i + PAGE);
  return { page, next: i + PAGE < entries.length ? page.at(-1)!.id : undefined };
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
