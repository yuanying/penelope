---
name: signal
description: Signal direct messages with the people the deployment allows, and the Signal groups it allows. What they send comes as events; you answer with curl to the send endpoint. Read before answering on Signal.
---

# Signal

The deployment's connector of the same name says whether this agent is on Signal, the host its send endpoint has
(`signal.penelope.internal` unless it says otherwise), who it may write to and which groups it is in.

## What comes in

- Messages and reactions in direct conversations from the senders the deployment allows, and from anyone in the groups it
  allows, come as events of the Signal plugin's source (`signal` unless the deployment named it otherwise). Other groups and
  anyone else are not read.
- A direct message comes at once, its text inline. A reaction (`reacted 👍` on one of your messages, by its `target_timestamp`)
  is batched.
- In a group (`payload.group.name`), a message comes at once when it is for you: it mentions you (`mentions_me`, written `@you`
  in the text), quotes you (`quote.mine`), has your name in it, or follows a post of yours (within 10 minutes, or the next one
  after yours). Those are for you to judge, not orders: a name may be about you, and what follows your post may be people
  talking to each other. Anything else in the group comes batched, a while later. Join in when you can help or are spoken to,
  briefly; otherwise say nothing.
- They are kept under `/sources/<source>/dm.<number>/` and `/sources/<source>/group.<name>/`, one JSON line a message, and
  the files that came with one under `/sources/<source>/files/`. Images also come into the turn as images. Your own posts
  to a group are there too, with `own: true`.
- `payload.timestamp` is Signal's own time of the message; a quoted reply carries `quote.timestamp` and the head of what it
  quoted (in a group also `quote.author`).

## Answering

Send a form to `/v1/send`: `text` (the standard input below), `to` (left out, the first allowed sender) or `group` (a group's
name), and `file` once per file, such as an image you drew. To answer one message in a group, quote it: `quote_timestamp`
is its `payload.timestamp` and `quote_author` its `from.number` (or `from.uuid` when it has no number).

```
printf '%s' '<text>' | curl -sS --fail-with-body -F 'text=<-' [-F 'to=+81…' | -F 'group=<name>'] \
  [-F 'quote_timestamp=…' -F 'quote_author=…'] [-F 'file=@picture.png'] https://signal.penelope.internal/v1/send
```

- Give a file its type when you can, `-F 'file=@video.webp;type=image/webp'`: curl itself knows only a few (png, jpg,
  gif) and sends the rest as `application/octet-stream`. Without one, the type is taken from the name's extension (png, jpg,
  gif, webp, mp4, mov, m4a, ogg, pdf); anything else arrives on Signal as a plain file, not as a picture or a video.
- It answers `{"timestamp": …}`, Signal's time of what you sent, which a reaction or a quote points back at.
- `403`: `to` is not one of the allowed senders, or `group` not one of the groups. `400`: neither text nor a file, or both `to`
  and `group`. `502`: signal-cli or Signal refused it, or signal-cli gave no answer in time (`no answer in time`, the
  connection closed). In the last case it may have gone out all the same: do not send it again as it is, say it may not have
  arrived instead. `503`: signal-cli is not connected just now, nothing was sent; try again in a while.
- What you send to a group is read by everyone in it at once, and nothing checks it before it goes. Keep your owner's private
  matters out of it.
- While you work on a direct message, or a group message that mentions you or quotes you, its conversation shows you typing,
  until you send there or a few minutes pass. Sending stops it, so a short "looking into it" message also ends it.
- Signal's text has no markup. Write plain text.
