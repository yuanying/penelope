// The main agent's tools: house replies, the backend's API, sub-agents and background jobs.

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { A2A_IMAGE_MAX_BYTES, A2A_IMAGES_MAX, HOUSE_EXPRESSIONS, HOUSE_REPLY_TEXT_MAX, MOOD_MAX_LENGTH, REPLY_IMAGE_MAX_BYTES, REPLY_IMAGES_MAX, type ReplyImageUpload } from "@penelope/contract";
import { Type } from "typebox";

import type { Backend } from "./backend.ts";
import { describeHouseReply, type HouseConnection, postHouseReply } from "./house.ts";
import type { Jobs } from "./jobs.ts";
import type { SubAgents } from "./subagents.ts";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: undefined };
}

/**
 * The files of a reply's images, read: each a regular file of at most the
 * limit, relative paths from HOME. The receiving service checks their type from their bytes.
 */
async function readImages(paths: readonly string[], home: string, maxImages = REPLY_IMAGES_MAX, maxBytes = REPLY_IMAGE_MAX_BYTES): Promise<ReplyImageUpload[]> {
  if (paths.length > maxImages) throw new Error(`Not sent: a reply carries at most ${maxImages} images, not ${paths.length}.`);
  const images: ReplyImageUpload[] = [];
  for (const path of paths) {
    const file = resolve(home, path);
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      if (info.size > maxBytes) throw new Error(`${info.size} bytes, over the ${maxBytes} an image may have`);
      images.push({ name: basename(file), data: (await readFile(file)).toString("base64") });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`Not sent: ${path}: ${why}.`);
    }
  }
  return images;
}

export function backendTools(backend: Backend, { home, house, recordHouseReply }: {
  home: string;
  house?: HouseConnection;
  recordHouseReply?: (id: string) => void;
}): ToolDefinition[] {
  // Folding keeps direct replies from the transcript. Pi records nested calls only inside codemode.
  const reply = defineTool({
    name: "reply",
    exposure: "model-only",
    label: "Reply",
    description:
      "Send a message to your current room in the house, or directly to your owner when you are away. The house decides where it goes when it is sent. Your turn text is not sent.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({
        maxLength: HOUSE_REPLY_TEXT_MAX,
        description: `The message, at most ${HOUSE_REPLY_TEXT_MAX} characters. It can be blank or omitted when you attach an image.`,
      })),
      expression: Type.Optional(Type.Enum(HOUSE_EXPRESSIONS, { description: "The expression shown with the message." })),
      to: Type.Optional(Type.Unknown({
        description: "In a room, a list of up to 50 resident IDs to address. Others in the room can still hear the message. When you are away, the house ignores this value.",
      })),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description: `Paths of image files to show with the message, relative to your home or absolute: PNG, JPEG, GIF or WebP, at most ${REPLY_IMAGES_MAX}, each at most ${REPLY_IMAGE_MAX_BYTES} bytes. Recipients see copies made when the message is sent. Changing a file later does not change the copy. If one of them cannot be sent, nothing of the message is sent, and the error says why.`,
        }),
      ),
    }),
    async execute(_id, { text: message = "", expression, to, images: paths }, signal) {
      if (!house) throw new Error("Not sent: the house is not configured for this deployment.");
      if (message.length > HOUSE_REPLY_TEXT_MAX) throw new Error(`Not sent: the text can have at most ${HOUSE_REPLY_TEXT_MAX} characters.`);
      if (!message.trim() && !paths?.length) throw new Error("Not sent: a reply needs text or an image.");
      const images = paths?.length ? await readImages(paths, home) : undefined;
      const result = await postHouseReply(house, {
        text: message,
        ...(expression === undefined ? {} : { expression }),
        ...(to === undefined ? {} : { to }),
        ...(images === undefined ? {} : { images }),
      }, signal);
      recordHouseReply?.(result.id);
      return text(describeHouseReply(result));
    },
  });

  const sleep = defineTool({
    name: "sleep",
    exposure: "model-only",
    label: "Sleep",
    description: "Sleep after the current turn. No events reach you until the accepted wake time. Another call before the session switch finishes replaces the wake time.",
    parameters: Type.Object({
      wake_at: Type.String({ description: "The future wake time in RFC 3339, with a time zone." }),
    }),
    async execute(_id, params) {
      const { wake_at, duration_seconds, clamped } = await backend.sleep(params);
      const hours = Math.floor(duration_seconds / 3600);
      const minutes = Math.floor(duration_seconds / 60) % 60;
      const seconds = duration_seconds % 60;
      const duration = [hours && `${hours}h`, minutes && `${minutes}m`, seconds && `${seconds}s`].filter(Boolean).join(" ");
      const when = `${wake_at} (${duration} from now)`;
      return text(clamped ? `Wake time clamped to ${when} by the maximum sleep duration.` : `Sleep requested until ${when}.`);
    },
  });

  const mood = defineTool({
    name: "mood",
    exposure: "model-only",
    label: "Mood",
    description: "Set your current mood. It stays until you change it, even when you sleep.",
    parameters: Type.Object({
      mood: Type.String({ minLength: 1, maxLength: MOOD_MAX_LENGTH, description: "One short line in your own words." }),
    }),
    async execute(_id, params) {
      await backend.setMood(params);
      return text("Mood set.");
    },
  });

  const replyToAgent = defineTool({
    name: "reply_to_agent",
    exposure: "model-only",
    label: "Reply to an agent",
    description:
      "Answer another agent in the A2A task of an `a2a` event. The event's stream is the agent's name, and its payload has the agent's text and the task. `completed` closes the task with optional text and images as its answer. To close the task without answering, use `completed` without text or images. `input-required` asks the agent the text and keeps the task open; the agent's answer comes as another `a2a` event of the same task. The agent fetches what you send from its task; your owner does not see it. A task the agent has not written to within the backend's deadline fails, and can no longer be answered.",
    parameters: Type.Object({
      in_reply_to: Type.Integer({ description: "The seq of an `a2a` event of the task." }),
      state: Type.Union([Type.Literal("completed"), Type.Literal("input-required")], {
        description: "completed: close the task. input-required: ask the agent, and wait for its answer.",
      }),
      text: Type.Optional(Type.String({ description: "The answer, or the question. Needed for input-required." })),
      images: Type.Optional(Type.Array(Type.String(), {
        description: `For completed only: paths to PNG, JPEG, GIF or WebP files, absolute or relative to HOME. Up to ${A2A_IMAGES_MAX} files, each up to 5 MiB. The sender gets copies in the Task artifact. If an image cannot be sent, the Task is not completed.`,
      })),
    }),
    async execute(_id, { images: paths, ...reply }) {
      if (paths?.length && reply.state !== "completed") throw new Error("Not sent: only a completed answer can carry images.");
      const images = paths?.length ? await readImages(paths, home, A2A_IMAGES_MAX, A2A_IMAGE_MAX_BYTES) : undefined;
      const task = await backend.a2aReply({ ...reply, ...(images === undefined ? {} : { images }) });
      return text(`Sent: the task is ${task.state}.`);
    },
  });

  const scheduleAdd = defineTool({
    name: "schedule_add",
    label: "Add a schedule",
    description:
      "Schedule an event to yourself: at a time (RFC 3339), or repeatedly by a cron expression. When it comes due, a `cron` event with the reason reaches you.",
    parameters: Type.Object({
      reason: Type.String({ description: "What the event is for. It comes back as the event's summary." }),
      cron: Type.Optional(Type.String({ description: "A cron expression with five fields." })),
      at: Type.Optional(Type.String({ description: "One time, RFC 3339." })),
    }),
    async execute(_id, params) {
      if ((params.cron === undefined) === (params.at === undefined)) {
        throw new Error("give either cron or at");
      }
      const schedule = await backend.createSchedule(
        params.cron !== undefined ? { reason: params.reason, cron: params.cron } : { reason: params.reason, at: params.at! },
      );
      return text(JSON.stringify(schedule));
    },
  });

  const scheduleList = defineTool({
    name: "schedule_list",
    label: "List schedules",
    description: "List your schedules.",
    parameters: Type.Object({}),
    async execute() {
      return text(JSON.stringify(await backend.listSchedules()));
    },
  });

  const scheduleRemove = defineTool({
    name: "schedule_remove",
    label: "Remove a schedule",
    description: "Remove one of your schedules by its id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      await backend.deleteSchedule(params.id);
      return text(`Removed ${params.id}.`);
    },
  });

  const selfEvent = defineTool({
    name: "self_event",
    label: "Event to yourself",
    description:
      "Put an event to yourself into your queue, as a `self` event. It reaches you like any other event. An id that was used before is dropped as a duplicate.",
    parameters: Type.Object({
      id: Type.String({ description: "Unique among your own events." }),
      summary: Type.String({ description: "One line." }),
      payload: Type.Optional(Type.Unknown({ description: "Any JSON, written to /sources/self/." })),
    }),
    async execute(_id, params) {
      await backend.selfEvent({ id: params.id, summary: params.summary, payload: params.payload ?? null });
      return text(`Queued ${params.id}.`);
    },
  });

  return [reply, sleep, mood, replyToAgent, scheduleAdd, scheduleList, scheduleRemove, selfEvent] as ToolDefinition[];
}

export function subAgentTools(agents: SubAgents): ToolDefinition[] {
  const start = defineTool({
    name: "subagent_start",
    label: "Start a sub-agent",
    description:
      "Start a sub-agent: another Pi session, run by the runner in this sandbox, with Pi's tools and the shell but none of reply, reply_to_agent, the schedules, self_event or the subagent_ tools. It returns as soon as the sub-agent has started, and the sub-agent runs in the background. Each time it stops, a `self` event reaches you with its name as the stream; the payload has why it stopped (`stopped`, `failed`, or `interrupted` when the runner stopped during its run), its purpose, and the whole text of its last answer. Its system prompt says it is your sub-agent, its purpose and working directory, the sandbox, the connectors and the skills, followed by the body of /memory/agents/<role>.md, or of /memory/agents/default.md when no role is given. It is not given your personality or your memory files. A name is used once, and is not used again after the sub-agent is closed.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Its name: lowercase letters, digits and -, starting with a letter or a digit, at most 63 characters, not main. The stream of its events, and its working directory ~/agents/<name>/ when none is given.",
      }),
      purpose: Type.String({ description: "One line on what it is for, shown by subagent_list and on your owner's screen." }),
      prompt: Type.String({ description: "The first request, given to it as it is." }),
      role: Type.Optional(Type.String({ description: "A role: the file /memory/agents/<role>.md." })),
      cwd: Type.Optional(Type.String({ description: "Its working directory, which must exist. Left out, ~/agents/<name>/ is made." })),
    }),
    async execute(_id, params) {
      return text(await agents.start(params));
    },
  });

  const send = defineTool({
    name: "subagent_send",
    label: "Send to a sub-agent",
    description:
      "Send more words to a sub-agent that has stopped and is waiting. It goes on in the same session, in the background, and another `self` event reaches you when it stops again. A running sub-agent takes no words.",
    parameters: Type.Object({
      name: Type.String({ description: "The sub-agent's name." }),
      text: Type.String({ description: "The words, given to it as they are." }),
    }),
    async execute(_id, params) {
      return text(await agents.send(params.name, params.text));
    },
  });

  const list = defineTool({
    name: "subagent_list",
    label: "List sub-agents",
    description:
      "List the sub-agents that are not closed, as JSON: each one's name, state (running, or waiting after it stopped), purpose and working directory. Sub-agents stay until they are closed, across nights.",
    parameters: Type.Object({}),
    async execute() {
      return text(JSON.stringify(agents.list()));
    },
  });

  const close = defineTool({
    name: "subagent_close",
    label: "Close a sub-agent",
    description:
      "Close a sub-agent. A run it is in is cancelled, with no event for it. A closed sub-agent takes no more words. Its working directory and the record of its session are kept.",
    parameters: Type.Object({ name: Type.String({ description: "The sub-agent's name." }) }),
    async execute(_id, params) {
      return text(await agents.close(params.name));
    },
  });

  return [start, send, list, close] as ToolDefinition[];
}

export function jobTools(jobs: Jobs, limits: { max: number; maxSeconds: number; tailChars: number }): ToolDefinition[] {
  const start = defineTool({
    name: "job_start",
    label: "Start a background job",
    description: `Run a shell command in the background, under bash in a process group of its own, as you and through the Sentinel like any other. It returns as soon as the command has started, with the job's id and the file its standard output and standard error both go to. When the command ends, a \`job\` event reaches you: how it ended (\`exited\` with its exit code, \`signaled\`, \`stopped\` by job_stop, \`timed-out\`, or \`interrupted\` when the runner started again while it ran), the command, how long it took, the file, and the last ${limits.tailChars} characters of the output. At most ${limits.max} jobs run at once, and one runs at most ${limits.maxSeconds} seconds; then its process group is ended. Jobs keep running across the nightly switch, and their ends reach the next session.`,
    parameters: Type.Object({
      command: Type.String({ description: "The command, as bash -c takes it." }),
      cwd: Type.Optional(Type.String({ description: "The working directory, which must exist; relative to your home. Left out, your home." })),
      timeout_seconds: Type.Optional(Type.Integer({ description: `How long it may run, at most ${limits.maxSeconds} seconds, the default.` })),
    }),
    async execute(_id, params) {
      return text(JSON.stringify(await jobs.start(params)));
    },
  });

  const list = defineTool({
    name: "job_list",
    label: "List background jobs",
    description: "List the background jobs that are running, as JSON: each one's id, command, working directory, start, time limit and output file.",
    parameters: Type.Object({}),
    async execute() {
      return text(JSON.stringify(jobs.list()));
    },
  });

  const stop = defineTool({
    name: "job_stop",
    label: "Stop a background job",
    description:
      "Stop a running background job: SIGTERM to its process group, then SIGKILL if it has not ended after a few seconds. It returns once the job has ended; its `job` event follows, as `stopped`.",
    parameters: Type.Object({ id: Type.String({ description: "The job's id." }) }),
    async execute(_id, params) {
      await jobs.kill(params.id);
      return text(`Stopped ${params.id}.`);
    },
  });

  return [start, list, stop] as ToolDefinition[];
}
