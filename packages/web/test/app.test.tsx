import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { act, cleanup, render, screen } from "@testing-library/react";

import { App } from "../src/ui/App.tsx";
import { words } from "../src/ui/words.ts";
import { FakeBackend } from "./fake-backend.ts";

afterEach(() => cleanup());

it("opens the memory page at the root address", async () => {
  const backend = new FakeBackend();
  render(<App fetch={backend.fetch} />);
  assert.ok(await screen.findByRole("region", { name: "記憶" }));
});

it("names the personal page after the deployment's agent", async () => {
  const backend = new FakeBackend();
  backend.agent = { name: "Kestrel" };
  render(<App fetch={backend.fetch} />);
  assert.ok(await screen.findByText("Kestrel"));
  assert.equal(document.title, "Kestrel");
});

it("asks for a login instead of showing the personal page without a session", async () => {
  const backend = new FakeBackend();
  backend.signedIn = false;
  render(<App fetch={backend.fetch} />);
  const link = await screen.findByRole("link");
  assert.equal(link.getAttribute("href"), "/auth/github/start");
  assert.equal(screen.queryByRole("button", { name: words.logout }), null);
});

it("returns to the login screen when the owner signs out", async () => {
  const backend = new FakeBackend();
  render(<App fetch={backend.fetch} />);
  const logout = await screen.findByRole("button", { name: words.logout });
  await act(async () => logout.click());
  assert.ok(await screen.findByRole("link"));
});
