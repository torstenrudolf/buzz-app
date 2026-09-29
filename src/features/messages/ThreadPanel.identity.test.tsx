// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import {
  keypair,
  message,
  profile,
  scriptedTransport,
  signed,
} from "../relay/testing";
import { ThreadPanel } from "./ThreadPanel";

const bodyRender = vi.fn();
vi.mock("./MessageMarkdown", () => ({
  MessageMarkdown: ({ row }: { row: ChannelMessage }) => {
    bodyRender(row.content);
    return <span>{row.content}</span>;
  },
}));
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
vi.mock("./MediaAttachment", () => ({
  MediaAttachment: ({ seekTo }: { seekTo?: number }) => (
    <span data-testid="video-seek">{seekTo ?? "none"}</span>
  ),
}));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);

afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("retains mounted rows through a deferred real-session page and profile noise", async () => {
  const relay = keypair();
  const viewer = keypair();
  const aliceKey = keypair();
  const bobKey = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let traffic!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters[0]?.kinds?.includes(30315)) return Promise.resolve([]);
      return wire.transport.query(filters, signal);
    },
    subscribe(callbacks) {
      traffic = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const root = message(aliceKey, "a", "Root body", 1, [
    ["imeta", "url https://example.com/video.mp4", "m video/mp4"],
  ]);
  const reply = message(bobKey, "a", "⏱ 0:42 — Reply body", 2, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  traffic.receive([
    root,
    reply,
    profile(aliceKey, { name: "Alice" }),
    profile(bobKey, { name: "Bob" }),
  ]);
  const session = owner.session;

  render(
    <StrictMode>
      <ThreadPanel
        session={session}
        scope="identity-test"
        channelName="A"
        channelId="a"
        messageId={root.id}
        close={() => {}}
        onOpenLink={() => false}
      />
    </StrictMode>,
  );

  await waitFor(() =>
    expect(wire.pending.some((request) => !request.signal?.aborted)).toBe(true),
  );
  const initial = wire.pending.find((request) => !request.signal?.aborted);
  if (!initial) throw new Error("Initial thread page was not requested");
  initial.respond([root, reply]);
  expect(await screen.findByText("Alice")).toBeInTheDocument();
  expect(screen.getByText("Bob")).toBeInTheDocument();
  await waitFor(() =>
    expect(
      wire.pending.filter(
        (request) => request !== initial && !request.signal?.aborted,
      ),
    ).toHaveLength(1),
  );
  const page = wire.pending.find(
    (request) => request !== initial && !request.signal?.aborted,
  );
  if (!page) throw new Error("Deferred thread page was not requested");
  expect(screen.queryByText("Loading thread…")).not.toBeInTheDocument();
  bodyRender.mockClear();

  // An unrelated signed profile preserves the selected map, but the shared
  // name service still invalidates every mounted row. Do not claim zero renders.
  await act(async () => {
    traffic.receive([profile(keypair(), { name: "Other" })]);
  });
  expect(bodyRender.mock.calls).toEqual([
    ["Root body"],
    ["Root body"],
    ["Reply body"],
    ["Reply body"],
  ]);
  bodyRender.mockClear();

  const appended = message(bobKey, "a", "Appended reply body", 3, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ]);
  await act(async () => page.respond([root, appended]));
  expect(await screen.findByText("Appended reply body")).toBeInTheDocument();
  expect(bodyRender.mock.calls).toEqual([
    ["Appended reply body"],
    ["Appended reply body"],
  ]);
  bodyRender.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "0:42" }));
  expect(screen.getByTestId("video-seek")).toHaveTextContent("42");
  bodyRender.mockClear();

  const edited = signed(bobKey, {
    kind: 40003,
    content: "Edited reply body",
    created_at: 4,
    tags: [["e", reply.id]],
  });
  traffic.receive([edited]);
  expect(await screen.findByText("Edited reply body")).toBeInTheDocument();
  expect(bodyRender).toHaveBeenCalledWith("Edited reply body");
  bodyRender.mockClear();

  await act(async () => {
    traffic.receive([profile(bobKey, { name: "Robert" }, 1_700_000_001)]);
  });
  expect(await screen.findAllByText("Robert")).toHaveLength(2);
  expect(bodyRender).toHaveBeenCalled();
  owner.dispose();
});
