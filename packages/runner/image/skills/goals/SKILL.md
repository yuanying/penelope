---
name: goals
description: Long-lasting goals, daily tasks and today's plan, kept in goals/ of the memory. Read when reading or writing goals/, and in the first turn of a day, when the plan is made.
---

# Goals and today's plan

`/memory/goals/` holds the long-lasting goals and today's plan.

- A long-lasting goal has no end (such as "keep the cluster healthy"). One goal is one `.md` directly in `goals/`.
- A short goal has a condition or a date at which it ends. It is written in the file of the long-lasting goal it serves.
- A daily task is done every day, at no set time. It is written in the file of the long-lasting goal it serves too.
- Today's plan is `/memory/goals/today.md`.

What you are there for is in your personality and `always.md`, not in goals.
Work whose time matters ("every morning at nine") is a schedule (`schedule_add`). A daily task is work done some time that day.

The headings and marks below are in Japanese, as natsumi wrote these files, so that a memory brought from natsumi reads the same.

## When there is no goals/

With no `goals/` (no file of a long-lasting goal), there are no goals, and no plan is made. A heartbeat is then like any other event:
what to do, if anything, is yours to judge. When goals look useful, you can suggest them to your owner; they are written once your
owner agrees (below, "Your owner's agreement").

## The file of a long-lasting goal

`/memory/goals/<ID>.md`. The ID is lower-case letters, digits and hyphens (such as `cluster-health`), and does not change, since the
plan refers to it. The first line is `# ` and the goal in short. Under it are these four sections, with these headings, in this
order.

| Section | What is in it | Written |
| --- | --- | --- |
| `## なぜ` | The words of the goal: what it is for | once your owner agrees |
| `## 日課` | The daily tasks, one a line | once your owner agrees |
| `## 今の様子` | Lines starting with the day it was seen (`YYYY-MM-DD`), and how things were | freely |
| `## 短い目標` | `- [ ]` (not yet) and `- [x]` (done), with `（期限 YYYY-MM-DD）` when there is a date | freely |

- In `今の様子`, a line is changed rather than the same thing written again. Old lines are summed up shorter.
- Done short goals are taken out when the plan is made again; git keeps their history.
- `goals/` has no directories, only `.md` files.

## Today's plan (today.md)

The first line is `# ` and the plan's date alone (`YYYY-MM-DD` in your owner's time zone). Under it, what is done today, one a line.

```markdown
# 2026-10-31

- [ ] cluster-health: アラートの一覧を見る（日課）
- [ ] cluster-health: ノードの OS の更新の手順をまとめる
- [x] 頼まれた、週末の天気を調べる
- 持ちかけ中: reading を長く続く目標に足すこと（2026-10-31 10:20）
```

- A line for a goal starts with its ID. A daily task has `（日課）`.
- A done line becomes `- [x]`, and stays for the rest of the day.
- What you were asked can be added too, and the plan can be rewritten during the day.
- What waits for your owner's answer is a `持ちかけ中:` line.

## Making the plan

In the first turn of the day (a heartbeat included), look at the first line of `today.md`.

**When its date is not today (or there is no `today.md`)**, the plan is made again. This is the only time all the goals are looked
over.

1. Read the files of the long-lasting goals in `goals/`.
2. Put every goal's daily tasks in the plan.
3. Of the short goals, choose those that can move forward today, as much as ends today.
4. Take the done short goals out of the goals' files.
5. Carry over the `持ちかけ中:` lines of the last plan that have had no answer.
6. Write `today.md` anew.

**When its date is today**, go on with the plan.

- Move on with the lines not done. One turn need not do them all.
- When one is done, make its line `- [x]` and change `今の様子` and `短い目標` of its goal.
- When all are done, add a short goal that can be done today, if there is one, and go on; if not, end without doing anything.
- What is done, or waiting, is not a reason to speak to your owner. Speak when there is something they would want to know or to
  check.
- A suggestion waiting for an answer does not move until the answer comes, and is not asked again.

What you write is committed by the backend at the end of the turn, as the rest of the memory is.

## Your owner's agreement

These are written once your owner agrees, in the conversation:

- adding or taking out a long-lasting goal (making or removing its file)
- changing `なぜ` (rewording it too)
- changing `日課` (adding, taking out or rewording)

1. Sum up what you want to change and why, with the words you have in mind, and suggest it with `reply`.
2. Write a `持ちかけ中:` line in `today.md`.
3. When your owner agrees, write it as agreed and take the line out. When they do not, take the line out without writing it.

A daily task or a short goal that serves no goal is the sign to suggest a new long-lasting goal. Something kept watched in
`always.md` or in schedules can be suggested as a goal and its daily tasks as well (a schedule whose time matters stays one).
