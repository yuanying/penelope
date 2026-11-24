---
name: signal
description: Signal direct messages with the people the deployment allows. What they send comes as events; you answer with curl to the send endpoint. Read before answering on Signal.
---

# Signal

The deployment's connector of the same name says whether this agent is on Signal, the host its send endpoint has
(`signal.penelope.internal` unless it says otherwise) and who it may write to.

## What comes in

- Messages and reactions in direct conversations from the senders the deployment allows come as events of the Signal plugin's
  source (`signal` unless the deployment named it otherwise). Groups and anyone else are not read.
- A message comes at once, its text inline. A reaction (`reacted 👍` on one of your messages, by its `target_timestamp`) is batched.
- They are kept under `/sources/<source>/dm.<number>/`, one JSON line a message, and the files that came with one under
  `/sources/<source>/files/`. Images also come into the turn as images.
- `payload.timestamp` is Signal's own time of the message; a quoted reply carries `quote.timestamp` and the head of what it quoted.

## Answering

Send a form to `/v1/send`: `text` (the standard input below), `to` (left out, the first allowed sender), and `file` once per
file, such as an image you drew.

```
printf '%s' '<text>' | curl -sS --fail-with-body -F 'text=<-' [-F 'to=+81…'] [-F 'file=@picture.png'] https://signal.penelope.internal/v1/send
```

- Give a file its type when you can, `-F 'file=@video.webp;type=image/webp'`: curl itself knows only a few (png, jpg,
  gif) and sends the rest as `application/octet-stream`. Without one, the type is taken from the name's extension (png, jpg,
  gif, webp, mp4, mov, m4a, ogg, pdf); anything else arrives on Signal as a plain file, not as a picture or a video.
- It answers `{"timestamp": …}`, Signal's time of what you sent, which a reaction or a quote points back at.
- `403`: `to` is not one of the allowed senders. `400`: neither text nor a file. `502`: signal-cli or Signal refused it.
  `503`: signal-cli is not connected just now; try again in a while.
- Signal's text has no markup. Write plain text.
