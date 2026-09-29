// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { afterEach, expect, it, vi } from "vitest";
import { relayBrokerPlugin } from "../../../dev/relay-broker.mjs";
import { AgentCard } from "../../bundled/agents/AgentCard";
import { controlFixture } from "../agents/control-testing";
import { keypair } from "../relay/testing";
import { AgentEditor } from "../../bundled/agents/AgentEditor";
import { createAgentControl } from "../agents/control";

const community = "https://unjoined.example";
const picture = `${community}/media/avatar.png`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function preview(
  kind: "card" | "editor" | "display-only",
  value = picture,
  relay = community,
) {
  const fixture = controlFixture();
  const agent = { ...fixture.agent, picture: value, relayUrl: relay };
  if (kind !== "card") {
    return (
      <AgentEditor
        agent={agent}
        control={createAgentControl(fixture.host)}
        state={{
          status: "ready",
          busy: false,
          error: null,
          data: {
            ...fixture.data,
            agents: [agent],
            avatarEditingAvailable: kind === "editor",
          },
        }}
        onClose={() => {}}
      />
    );
  }
  return <AgentCard name="Agent" identities={[]} editable={[agent]} />;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["card", "editor", "display-only"] as const)(
  "%s registers a persisted avatar destination on a fresh production broker before exposing its image",
  async (kind) => {
    const identity = keypair();
    const upstream = vi.fn(
      async () =>
        new Response("fixture", { headers: { "Content-Type": "image/png" } }),
    );
    let handler: RequestListener | undefined;
    const server = createServer((req, res) => handler?.(req, res));
    const plugin = relayBrokerPlugin({
      identity: () => identity.secret,
      upstreamFetch: upstream,
    });
    await (plugin.configureServer as (s: ViteDevServer) => Promise<void>)({
      httpServer: server,
      config: { logger: { info() {}, error() {} } },
      middlewares: {
        use(cb: RequestListener) {
          handler = cb;
        },
      },
    } as unknown as ViteDevServer);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nativeFetch = globalThis.fetch;
    const gate = deferred();
    const started = deferred();
    const brokerUrl = `/api/relay/${encodeURIComponent(community)}/media?url=${encodeURIComponent(picture)}`;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      requests.push(input);
      if (input.endsWith("/register")) {
        started.resolve();
        await gate.promise;
      }
      return nativeFetch(new URL(input, base), {
        ...init,
        headers: { ...init?.headers, Origin: base },
      });
    });
    try {
      expect((await nativeFetch(`${base}${brokerUrl}`)).status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      render(preview(kind));
      await act(async () => {
        await started.promise;
      });
      expect(document.querySelector("img")).toBeNull();
      await act(async () => {
        gate.resolve();
      });
      await waitFor(() =>
        expect(document.querySelector("img")).toHaveAttribute("src", brokerUrl),
      );
      const response = await nativeFetch(
        `${base}${document.querySelector("img")?.getAttribute("src")}`,
      );
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(requests).toEqual(["/api/relay/register"]); // No session, membership, or discovery dependency.
      const image = document.querySelector("img");
      if (!image) throw new Error("Registered avatar did not mount");
      fireEvent.load(image);
      expect(document.querySelector("img")).toHaveAttribute(
        "data-loaded",
        "true",
      );
      if (kind === "editor") {
        fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
        const artwork = await screen.findByRole("img", {
          name: "Avatar preview",
        });
        await waitFor(() =>
          expect(artwork.querySelector("img")).toHaveAttribute(
            "src",
            brokerUrl,
          ),
        );
      }
    } finally {
      gate.resolve();
      cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it("retires registration on destination change and unmount, ignoring late completion", async () => {
  const gates = [deferred(), deferred()] as const;
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
    const index = signals.length;
    signals.push(init?.signal as AbortSignal);
    const gate = gates[index];
    if (!gate) throw new Error("Unexpected extra registration");
    await gate.promise;
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(preview("card"));
  await waitFor(() => expect(signals).toHaveLength(1));
  view.rerender(
    preview(
      "card",
      "https://second.example/media/avatar.png",
      "https://second.example",
    ),
  );
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => {
    gates[0].resolve();
    await gates[0].promise;
  });
  expect(document.querySelector("img")).toBeNull();
  view.unmount();
  expect(signals[1]?.aborted).toBe(true);
  await act(async () => {
    gates[1].resolve();
    await gates[1].promise;
  });
});

it("keeps initials after rejected registration and never registers public artwork", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: "Denied" }, { status: 403 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = render(preview("card"));
  await act(async () => {
    await fetcher.mock.results[0]?.value;
  });
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
  view.rerender(preview("card", "https://images.example/public.png"));
  expect(document.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/public.png",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
