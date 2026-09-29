import { afterEach, expect, it, vi } from "vitest";
import {
  canStopAgent,
  createAgentControl,
  savedMessage,
  type GooseInstallReport,
} from "./control";
import { controlFixture } from "./control-testing";
import * as communityApi from "../communities/api";
import { agentDraft, agentEdit } from "../../bundled/agents/agent-edit";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("words save results by restart count", () => {
  expect(savedMessage(0)).toBe("Saved.");
  expect(savedMessage(undefined)).toBe("Saved.");
  expect(savedMessage(1)).toBe("Saved. Restarted 1 agent.");
  expect(savedMessage(3)).toBe("Saved. Restarted 3 agents.");
  expect(savedMessage(1, 1)).toBe(
    "Saved. Restarted 1 agent. 1 agent couldn’t restart with the new settings; check Agents.",
  );
  expect(savedMessage(0, 1)).toBe(
    "Saved. 1 agent couldn’t restart with the new settings; check Agents.",
  );
  expect(savedMessage(2, 3)).toBe(
    "Saved. Restarted 2 agents. 3 agents couldn’t restart with the new settings; check Agents.",
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("browser is unavailable without any host or runner", async () => {
  const control = createAgentControl(null);
  await control.refresh();
  expect(control.snapshot().status).toBe("unavailable");
  await expect(control.action("x", "start")).rejects.toThrow("desktop app");
});
it("coalesces reads and cannot replace post-action state with a stale read", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const old = structuredClone(fixture.data);
  const late = deferred<typeof old>();
  vi.spyOn(fixture.host, "snapshot").mockReturnValue(late.promise);
  const first = control.refresh();
  expect(control.refresh()).toBe(first);
  await control.action("fixture-agent", "stop");
  late.resolve(old);
  await first;
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(false);
  expect(control.snapshot().data?.agents[0]?.status).toBe("stopped");
});
it("does not optimistically mark an action successful or admit concurrent writes", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const action = deferred<typeof fixture.data>();
  vi.spyOn(fixture.host, "action").mockReturnValue(action.promise);
  const pending = control.action("fixture-agent", "stop");
  expect(control.snapshot().busy).toBe(true);
  expect(control.snapshot().data?.agents[0]?.status).toBe("running");
  await expect(control.action("fixture-agent", "start")).rejects.toThrow(
    "in progress",
  );
  action.resolve({ ...fixture.data, agents: [] });
  await pending;
  expect(control.snapshot().data?.agents).toEqual([]);
  expect(control.snapshot().busy).toBe(false);
});
it("uncertain writes retain last evidence and allow only explicit recovery Stop", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  vi.spyOn(fixture.host, "action").mockRejectedValue(
    new Error("RAW OUTPUT MUST NOT DISPLAY"),
  );
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "confirm",
  );
  expect(control.snapshot().error).not.toContain("RAW OUTPUT");
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().data?.agents[0]?.status).toBe("running");
  await expect(control.action("fixture-agent", "start")).rejects.toThrow(
    "Refresh",
  );
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "confirm",
  );
  expect(fixture.host.action).toHaveBeenCalledTimes(2);
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(true);
  await control.refresh();
  expect(control.snapshot().status).toBe("ready");
});
it("save leaves running revision alone; omitted environment values stay host-only", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const agent = fixture.agent;
  const edit = agentEdit({ ...agentDraft(agent), name: "New name" });
  const saved = await control.save(agent.id, 1, edit);
  expect(saved.agents[0]?.revision).toBe(2);
  expect(saved.agents[0]?.runningRevision).toBe(1);
  expect(saved.agents[0]?.harness.environmentKeys).toEqual(["EXAMPLE_TOKEN"]);
  expect(fixture.calls.filter((call) => call.action === "restart")).toEqual([]);
  await expect(control.save(agent.id, 1, edit)).rejects.toThrow();
});
it("delete applies only the native result and reports an unconfirmed delete", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const deleting = control.delete?.("fixture-agent", 1);
  expect(control.snapshot().busy).toBe(true);
  expect(control.snapshot().data?.agents).toHaveLength(1);
  await deleting;
  expect(control.snapshot().data?.agents).toEqual([]);
  expect(control.snapshot().busy).toBe(false);
  await expect(control.delete?.("fixture-agent", 1)).rejects.toThrow("confirm");
  expect(control.snapshot().error).toContain("Agent no longer exists");
  expect(createAgentControl(null).delete).toBeUndefined();
});
it("subscription cleanup and disposal never send stop or accept a late snapshot", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  const listener = vi.fn();
  const unsubscribe = control.subscribe(listener);
  await control.refresh();
  unsubscribe();
  const late = deferred<typeof fixture.data>();
  vi.spyOn(fixture.host, "snapshot").mockReturnValue(late.promise);
  const pending = control.refresh();
  const before = control.snapshot();
  listener.mockClear();
  control.dispose();
  late.resolve({ runtimeAvailable: false, agents: [] });
  await pending;
  expect(listener).not.toHaveBeenCalled();
  expect(control.snapshot()).toBe(before);
  expect(fixture.calls.some((call) => call.action === "stop")).toBe(false);
});
it("failed refresh exposes retry while retaining the last snapshot", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  vi.spyOn(fixture.host, "snapshot").mockRejectedValue("failure");
  await control.refresh();
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().data?.agents).toHaveLength(1);
});
it("keeps read errors visible during recovery and clears global operation errors on success", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const action = vi
    .spyOn(fixture.host, "action")
    .mockRejectedValueOnce("Start was not confirmed.");
  await expect(control.action(fixture.agent.id, "start")).rejects.toThrow(
    "confirm",
  );
  const snapshot = vi
    .spyOn(fixture.host, "snapshot")
    .mockRejectedValueOnce("read failure");
  await control.refresh();
  expect(control.snapshot().error).toContain(
    "Current host status is unconfirmed",
  );
  const late = deferred<typeof fixture.data>();
  snapshot.mockReturnValueOnce(late.promise);
  const before = control.snapshot();
  const recovering = control.refresh();
  expect(control.snapshot()).toBe(before);
  late.resolve(structuredClone(fixture.data));
  await recovering;
  expect(control.snapshot()).toMatchObject({
    status: "ready",
    error: null,
  });
  expect(action).toHaveBeenCalledExactlyOnceWith(fixture.agent.id, "start");
});
it("status failure admits only Stop for a retained identity and still serializes it", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  vi.spyOn(fixture.host, "snapshot").mockRejectedValue("unreadable store");
  await control.refresh();
  const before = [...fixture.calls];
  const edit = agentEdit(agentDraft(fixture.agent));
  for (const attempt of [
    () => control.action("fixture-agent", "start"),
    () => control.action("fixture-agent", "restart"),
    () => control.action("unknown-agent", "stop"),
    () => control.save("fixture-agent", 1, edit),
    () => control.previewImport("installed", "wss://chosen.example"),
    () => control.commitImport("fixture-preview", ["second-fixture"]),
  ]) {
    await expect(attempt()).rejects.toThrow("Refresh");
  }
  expect(fixture.calls).toEqual(before);
  const action = deferred<typeof fixture.data>();
  const nativeAction = vi
    .spyOn(fixture.host, "action")
    .mockReturnValue(action.promise);
  const stopping = control.action("fixture-agent", "stop");
  expect(nativeAction).toHaveBeenCalledExactlyOnceWith("fixture-agent", "stop");
  expect(control.snapshot().busy).toBe(true);
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "in progress",
  );
  action.resolve({ ...fixture.data, agents: [] });
  await stopping;
  expect(control.snapshot().status).toBe("ready");
});
it("Stop recovery requires retained evidence, an available host and a live projection", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "Refresh",
  );
  const read = vi
    .spyOn(fixture.host, "snapshot")
    .mockRejectedValue("unreadable store");
  await control.refresh();
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "Refresh",
  );
  read.mockRestore();
  await control.refresh();
  control.dispose();
  await expect(control.action("fixture-agent", "stop")).rejects.toThrow(
    "desktop app",
  );
  const browser = createAgentControl(null);
  await expect(browser.action("fixture-agent", "stop")).rejects.toThrow(
    "desktop app",
  );
  expect(fixture.calls.filter((call) => call.action !== "snapshot")).toEqual(
    [],
  );
});
it("import forwards exact selection and never starts imported agents", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const preview = await control.previewImport(
    "development",
    "wss://chosen.example",
  );
  await control.commitImport(preview.token, ["second-fixture"]);
  expect(fixture.calls.slice(-2)).toEqual([
    {
      action: "preview",
      payload: { source: "development", destination: "wss://chosen.example" },
    },
    {
      action: "import",
      payload: { token: preview.token, ids: ["second-fixture"] },
    },
  ]);
  expect(control.snapshot().data?.agents[1]?.enabled).toBe(false);
});

for (const launch of ["start", "restart"] as const) {
  for (const otherAgent of [false, true]) {
    for (const rejectLaunch of [false, true]) {
      for (const launchFirst of [false, true]) {
        it(`${launch}: Stop ${otherAgent ? "another agent" : "pending agent"} survives late ${rejectLaunch ? "failure" : "success"} ${launchFirst ? "during" : "after"} Stop`, async () => {
          const fixture = controlFixture();
          fixture.agent.enabled = launch !== "start";
          fixture.agent.status = launch === "start" ? "stopped" : "running";
          fixture.data.agents.push({
            ...structuredClone(fixture.agent),
            id: "other",
            enabled: true,
            status: "running",
          });
          const control = createAgentControl(fixture.host);
          await control.refresh();
          const late = deferred<typeof fixture.data>();
          const stop = deferred<typeof fixture.data>();
          const before = structuredClone(fixture.data);
          const action = vi
            .spyOn(fixture.host, "action")
            .mockImplementation((_id, kind) =>
              kind === "stop"
                ? stop.promise
                : late.promise.then((data) => {
                    if (rejectLaunch) throw "Old launch failure";
                    return data;
                  }),
            );
          const starting = control
            .action(fixture.agent.id, launch)
            .catch(() => {});
          const target = otherAgent ? "other" : fixture.agent.id;
          expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
          expect(canStopAgent(control.snapshot(), "other")).toBe(true);
          expect(canStopAgent(control.snapshot(), "unknown")).toBe(false);
          const stopping = control.action(target, "stop");
          expect(action).toHaveBeenLastCalledWith(target, "stop");
          expect(canStopAgent(control.snapshot(), target)).toBe(false);
          await expect(control.action(target, "stop")).rejects.toThrow(
            "in progress",
          );
          if (launchFirst) {
            late.resolve(before);
            await starting;
            expect(control.snapshot().busy).toBe(true);
            expect(control.snapshot().error).toBeNull();
          }
          const stopped = structuredClone(before);
          const row = stopped.agents.find((agent) => agent.id === target);
          if (!row) throw new Error("Missing test agent");
          row.enabled = false;
          row.status = "stopped";
          stop.resolve(stopped);
          await stopping;
          const result = control.snapshot().data;
          if (!launchFirst) {
            expect(control.snapshot().busy).toBe(true);
            await expect(control.action(target, "restart")).rejects.toThrow(
              "in progress",
            );
            await expect(
              control.previewImport("installed", "wss://chosen.example"),
            ).rejects.toThrow("in progress");
            late.resolve(before);
            await starting;
          }
          expect(control.snapshot().data).toBe(result);
          expect(control.snapshot().data).toEqual(stopped);
          expect(control.snapshot().status).toBe("ready");
          expect(control.snapshot().error).toBeNull();
          expect(control.snapshot().busy).toBe(false);
        });
      }
    }
  }
}
it("a superseded launch cannot erase Stop's failure or allow writes while it waits", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const late = deferred<typeof fixture.data>();
  vi.spyOn(fixture.host, "action").mockImplementation((_id, action) =>
    action === "stop" ? Promise.reject("Disable not confirmed") : late.promise,
  );
  const launch = control.action(fixture.agent.id, "restart").catch(() => {});
  await expect(control.action(fixture.agent.id, "stop")).rejects.toThrow(
    "confirm",
  );
  const error = control.snapshot().error;
  expect(control.snapshot().busy).toBe(true);
  expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
  late.resolve(structuredClone(fixture.data));
  await launch;
  expect(control.snapshot().status).toBe("error");
  expect(control.snapshot().error).toBe(error);
  expect(control.snapshot().busy).toBe(false);
});

for (const importFirst of [false, true]) {
  for (const rejectImport of [false, true]) {
    for (const rejectStop of [false, true]) {
      it(`pending import: ${importFirst ? "import" : "Stop"} settles first; import ${rejectImport ? "fails" : "succeeds"}, Stop ${rejectStop ? "fails" : "succeeds"}`, async () => {
        const fixture = controlFixture();
        const control = createAgentControl(fixture.host);
        await control.refresh();
        const before = structuredClone(fixture.data);
        const imported = structuredClone(before);
        const importedAgent = {
          ...structuredClone(fixture.agent),
          id: "imported",
          enabled: false,
          status: "stopped" as const,
          runningRevision: null,
        };
        imported.agents.push(importedAgent);
        const importGate = deferred<void>();
        const stopGate = deferred<void>();
        vi.spyOn(fixture.host, "commitImport").mockImplementation(async () => {
          await importGate.promise;
          if (rejectImport) throw "Import custody failed";
          return imported;
        });
        const stopped = structuredClone(before);
        const stoppedAgent = stopped.agents[0];
        if (!stoppedAgent) throw Error("Missing Stop target");
        Object.assign(stoppedAgent, {
          enabled: false,
          status: "stopped",
          runningRevision: null,
        });
        const action = vi
          .spyOn(fixture.host, "action")
          .mockImplementation(async () => {
            await stopGate.promise;
            if (rejectStop) throw "Durable disable failed";
            return stopped;
          });
        const importing = control
          .commitImport("token", ["imported"])
          .catch(() => {});
        expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
        expect(canStopAgent(control.snapshot(), "unknown")).toBe(false);
        const stopping = control
          .action(fixture.agent.id, "stop")
          .catch(() => {});
        expect(action).toHaveBeenCalledExactlyOnceWith(
          fixture.agent.id,
          "stop",
        );
        expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(false);
        await expect(control.action(fixture.agent.id, "stop")).rejects.toThrow(
          "in progress",
        );
        if (importFirst) {
          importGate.resolve();
          await importing;
          expect(control.snapshot().data).toEqual(before);
          expect(control.snapshot().error).toBeNull();
        } else {
          stopGate.resolve();
          await stopping;
        }
        expect(control.snapshot().busy).toBe(true);
        for (const attempt of [
          () => control.action(fixture.agent.id, "start"),
          () => control.action(fixture.agent.id, "restart"),
          () =>
            control.save(
              fixture.agent.id,
              1,
              agentEdit(agentDraft(fixture.agent)),
            ),
          () => control.previewImport("installed", "wss://chosen.example"),
          () => control.commitImport("another", ["imported"]),
        ])
          await expect(attempt()).rejects.toThrow("in progress");
        const read = vi.spyOn(fixture.host, "snapshot");
        await control.refresh();
        expect(read).not.toHaveBeenCalled();
        if (importFirst) {
          stopGate.resolve();
          await stopping;
        } else {
          const evidence = control.snapshot();
          importGate.resolve();
          await importing;
          expect(control.snapshot().data).toBe(evidence.data);
          expect(control.snapshot().error).toBe(evidence.error);
        }
        expect(control.snapshot().busy).toBe(false);
        expect(control.snapshot().data).toEqual(rejectStop ? before : stopped);
        expect(control.snapshot().status).toBe(rejectStop ? "error" : "ready");
        if (rejectStop) {
          expect(control.snapshot().error).toContain("Durable disable failed");
          expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
        }
        // A superseded import may still commit. Only a fresh host read can merge
        // its disabled rows with the newer Stop evidence; never replay its snapshot.
        const latest = structuredClone(rejectStop ? before : stopped);
        if (!rejectImport) latest.agents.push(importedAgent);
        read.mockResolvedValue(latest);
        await control.refresh();
        expect(control.snapshot().data).toEqual(latest);
        expect(control.snapshot().status).toBe("ready");
        control.dispose();
      });
    }
  }
}

for (const operation of ["create", "profile"] as const) {
  for (const writeFirst of [false, true]) {
    for (const rejectWrite of [false, true]) {
      for (const rejectStop of [false, true]) {
        it(`${operation} credential wait: ${writeFirst ? "write" : "Stop"} settles first; write failure=${rejectWrite}, Stop failure=${rejectStop}`, async () => {
          const fixture = controlFixture();
          const created = {
            ...structuredClone(fixture.agent),
            id: "created",
            enabled: false,
            status: "stopped" as const,
            runningRevision: null,
            profilePending: true,
          };
          if (operation === "profile") fixture.data.agents.push(created);
          const before = structuredClone(fixture.data);
          const committed = structuredClone(before);
          if (operation === "create") committed.agents.push(created);
          else committed.agents[1] = { ...created, profilePending: false };
          const writeGate = deferred<void>();
          const started = deferred<void>();
          const stopGate = deferred<void>();
          const write = vi.fn(async () => {
            started.resolve();
            await writeGate.promise;
            if (rejectWrite) throw "Credential operation failed";
            return committed;
          });
          fixture.host.prepareCreate = vi.fn(async () => created);
          fixture.host.commitCreate = write;
          fixture.host.publishProfile = write;
          vi.spyOn(communityApi, "communityRequest").mockResolvedValue({
            auth: [],
          });
          const stopped = structuredClone(before);
          stopped.agents[0] = {
            ...fixture.agent,
            enabled: false,
            status: "stopped",
            runningRevision: null,
          };
          const action = vi
            .spyOn(fixture.host, "action")
            .mockImplementation(async () => {
              await stopGate.promise;
              if (rejectStop) throw "Durable disable failed";
              return stopped;
            });
          const control = createAgentControl(fixture.host);
          await control.refresh();
          const { create: createAgent, publishProfile } = control;
          if (!createAgent || !publishProfile)
            throw Error("Creation fixture unavailable");
          const create = () =>
            createAgent(
              "request",
              "https://relay.example.test",
              "owner",
              agentEdit(agentDraft(fixture.agent)),
            );
          const pending = (
            operation === "create" ? create() : publishProfile(created.id)
          ).catch(() => {});
          await started.promise;
          expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
          expect(canStopAgent(control.snapshot(), "unknown")).toBe(false);
          const stopping = control
            .action(fixture.agent.id, "stop")
            .catch(() => {});
          expect(action).toHaveBeenCalledExactlyOnceWith(
            fixture.agent.id,
            "stop",
          );
          await expect(
            control.action(fixture.agent.id, "stop"),
          ).rejects.toThrow("in progress");
          if (writeFirst) {
            writeGate.resolve();
            await pending;
            expect(control.snapshot().data).toEqual(before);
            expect(control.snapshot().error).toBeNull();
          } else {
            stopGate.resolve();
            await stopping;
          }
          expect(control.snapshot().busy).toBe(true);
          for (const attempt of [
            create,
            () => publishProfile(created.id),
            () => control.action(fixture.agent.id, "start"),
            () =>
              control.save(
                fixture.agent.id,
                1,
                agentEdit(agentDraft(fixture.agent)),
              ),
            () => control.commitImport("token", ["imported"]),
          ])
            await expect(attempt()).rejects.toThrow("in progress");
          const read = vi.spyOn(fixture.host, "snapshot");
          await control.refresh();
          expect(read).not.toHaveBeenCalled();
          if (writeFirst) {
            stopGate.resolve();
            await stopping;
          } else {
            const evidence = control.snapshot();
            writeGate.resolve();
            await pending;
            expect(control.snapshot().data).toBe(evidence.data);
            expect(control.snapshot().error).toBe(evidence.error);
          }
          expect(control.snapshot().busy).toBe(false);
          expect(control.snapshot().data).toEqual(
            rejectStop ? before : stopped,
          );
          expect(control.snapshot().status).toBe(
            rejectStop ? "error" : "ready",
          );
          if (rejectStop)
            expect(control.snapshot().error).toContain(
              "Durable disable failed",
            );
          const latest = structuredClone(rejectStop ? before : stopped);
          if (!rejectWrite) {
            if (operation === "create") latest.agents.push(created);
            else latest.agents[1] = { ...created, profilePending: false };
          }
          read.mockResolvedValue(latest);
          await control.refresh();
          expect(control.snapshot().data).toEqual(latest);
          expect(write).toHaveBeenCalledOnce();
          control.dispose();
        });
      }
    }
  }
}

it("mention wake matches exact key and community, carries replay floor, and later mention re-enables after Stop", async () => {
  const fixture = controlFixture();
  fixture.agent.enabled = false;
  fixture.agent.status = "stopped";
  fixture.data.agents.push(
    { ...fixture.agent, id: "namesake", pubkey: "cd".repeat(32) },
    { ...fixture.agent, id: "other-relay", relayUrl: "wss://other.example" },
  );
  const start = vi.spyOn(fixture.host, "action");
  const control = createAgentControl(fixture.host);
  const signal = new AbortController().signal;
  await control.prepareMention(
    [fixture.agent.pubkey],
    "https://relay.example.test",
    1234,
    signal,
  )();
  expect(start).toHaveBeenCalledExactlyOnceWith("fixture-agent", "start", 1234);
  await control.prepareMention(
    [fixture.agent.pubkey],
    "https://relay.example.test",
    1235,
    signal,
  )();
  expect(start).toHaveBeenCalledOnce();
  await control.action("fixture-agent", "stop");
  await control.prepareMention(
    [fixture.agent.pubkey],
    "https://relay.example.test",
    1236,
    signal,
  )();
  expect(start).toHaveBeenLastCalledWith("fixture-agent", "start", 1236);
  control.dispose();
});

for (const cancel of ["scope", "stop", "dispose"] as const) {
  it(`mention wake cannot start after ${cancel} during inventory read`, async () => {
    const fixture = controlFixture();
    const control = createAgentControl(fixture.host);
    await control.refresh();
    const read = deferred<typeof fixture.data>();
    vi.spyOn(fixture.host, "snapshot").mockReturnValue(read.promise);
    const action = vi.spyOn(fixture.host, "action");
    const lifetime = new AbortController();
    const wake = control.prepareMention(
      [fixture.agent.pubkey],
      fixture.agent.relayUrl,
      1234,
      lifetime.signal,
    )();
    await Promise.resolve();
    if (cancel === "scope") lifetime.abort();
    if (cancel === "stop") await control.action(fixture.agent.id, "stop");
    if (cancel === "dispose") control.dispose();
    read.resolve({
      ...fixture.data,
      agents: [{ ...fixture.agent, status: "stopped", enabled: false }],
    });
    await wake;
    expect(
      action.mock.calls.filter(([, command]) => command === "start"),
    ).toEqual([]);
    control.dispose();
  });
}

it("overlapping mentions coalesce the pending same-agent Start and Stop defeats its late completion", async () => {
  const fixture = controlFixture();
  fixture.host.attachMention = vi.fn(async () => {});
  fixture.agent.enabled = false;
  fixture.agent.status = "stopped";
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const launched = deferred<typeof fixture.data>();
  const native = fixture.host.action.bind(fixture.host);
  const action = vi
    .spyOn(fixture.host, "action")
    .mockImplementation((id, command) =>
      command === "start" ? launched.promise : native(id, command),
    );
  const signal = new AbortController().signal;
  const first = control.prepareMention(
    [fixture.agent.pubkey],
    fixture.agent.relayUrl,
    1234,
    signal,
  )();
  await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
  await control.prepareMention(
    [fixture.agent.pubkey],
    fixture.agent.relayUrl,
    1235,
    signal,
  )();
  expect(action).toHaveBeenCalledOnce();
  expect(fixture.host.attachMention).toHaveBeenCalledWith(
    fixture.agent.id,
    1,
    1235,
  );
  await control.action(fixture.agent.id, "stop");
  launched.resolve({
    ...fixture.data,
    agents: [{ ...fixture.agent, status: "running", enabled: true }],
  });
  await first;
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(false);
  expect(control.snapshot().mentionError).toBeUndefined();
  control.dispose();
});

it("failed automatic Start reports execution separately, without leaking raw host errors", async () => {
  const fixture = controlFixture();
  fixture.agent.status = "stopped";
  const control = createAgentControl(fixture.host);
  vi.spyOn(fixture.host, "action").mockRejectedValue(new Error("RAW SECRET"));
  await control.prepareMention(
    [fixture.agent.pubkey],
    fixture.agent.relayUrl,
    1234,
    new AbortController().signal,
  )();
  expect(control.snapshot().mentionError).toContain(
    "Message sent, but Fixture agent could not start",
  );
  expect(control.snapshot().mentionError).not.toContain("RAW SECRET");
  control.dismissMentionError();
  expect(control.snapshot().mentionError).toBeNull();
  control.dispose();
});

for (const uncertain of [false, true]) {
  it(`multiple recipients: first ${uncertain ? "uncertain" : "confirmed failed"} start never silently drops the second`, async () => {
    const fixture = controlFixture();
    fixture.agent.status = "stopped";
    const second = {
      ...fixture.agent,
      id: "second",
      name: "Second agent",
      pubkey: "cd".repeat(32),
    };
    fixture.data.agents.push(second);
    const action = vi
      .spyOn(fixture.host, "action")
      .mockImplementation(async (id) => {
        if (id === fixture.agent.id) {
          if (uncertain) throw "Native operation outcome unknown.";
          fixture.agent.status = "failed";
          fixture.agent.error = "Credentials unavailable.";
        } else second.status = "running";
        return structuredClone(fixture.data);
      });
    const control = createAgentControl(fixture.host);
    await control.prepareMention(
      [fixture.agent.pubkey, second.pubkey],
      fixture.agent.relayUrl,
      1234,
      new AbortController().signal,
    )();
    expect(action.mock.calls.map(([id]) => id)).toEqual(
      uncertain ? [fixture.agent.id] : [fixture.agent.id, second.id],
    );
    expect(control.snapshot().mentionError).toContain(
      "Fixture agent could not start",
    );
    if (uncertain)
      expect(control.snapshot().mentionError).toContain(
        "Second agent could not start",
      );
    else expect(second.status).toBe("running");
    control.dispose();
  });
}

it("a no-match mention is a native no-op and cannot erase an existing wake failure", async () => {
  const fixture = controlFixture();
  fixture.agent.status = "stopped";
  const action = vi
    .spyOn(fixture.host, "action")
    .mockRejectedValue("Credentials unavailable.");
  const control = createAgentControl(fixture.host);
  const signal = new AbortController().signal;
  await control.prepareMention(
    [fixture.agent.pubkey],
    fixture.agent.relayUrl,
    1234,
    signal,
  )();
  const error = control.snapshot().mentionError;
  await control.prepareMention(
    ["cd".repeat(32)],
    fixture.agent.relayUrl,
    1235,
    signal,
  )();
  expect(action).toHaveBeenCalledOnce();
  expect(control.snapshot().mentionError).toBe(error);
  control.dispose();
});

const transientRead = "Agent runtime is initializing; retry shortly";
it("keeps a coalesced read loading until native startup completes", async () => {
  vi.useFakeTimers();
  const fixture = controlFixture();
  const snapshot = vi
    .spyOn(fixture.host, "snapshot")
    .mockRejectedValueOnce(transientRead)
    .mockRejectedValueOnce(transientRead);
  const control = createAgentControl(fixture.host);
  const pending = control.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(control.refresh()).toBe(pending);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(control.snapshot()).toMatchObject({
    status: "loading",
    error: null,
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(control.snapshot().status).toBe("loading");
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(control.snapshot().status).toBe("ready");
  expect(control.snapshot().data).toEqual(fixture.data);
  expect(fixture.calls).toEqual([{ action: "snapshot" }]);
  control.dispose();
});
for (const previousSnapshot of [false, true]) {
  it(`bounds transient reads and retains previous evidence: ${previousSnapshot}`, async () => {
    vi.useFakeTimers();
    const fixture = controlFixture();
    const control = createAgentControl(fixture.host);
    if (previousSnapshot) await control.refresh();
    const snapshot = vi
      .spyOn(fixture.host, "snapshot")
      .mockRejectedValue(transientRead);
    const pending = control.refresh();
    await vi.advanceTimersByTimeAsync(4999);
    expect(snapshot).toHaveBeenCalledTimes(20);
    expect(control.snapshot().status).toBe(
      previousSnapshot ? "ready" : "loading",
    );
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(snapshot).toHaveBeenCalledTimes(21);
    expect(control.snapshot().status).toBe("error");
    expect(control.snapshot().data).toEqual(
      previousSnapshot ? fixture.data : null,
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(snapshot).toHaveBeenCalledTimes(21);
    snapshot.mockResolvedValue(fixture.data);
    await control.refresh();
    expect(control.snapshot().status).toBe("ready");
    control.dispose();
  });
}
it("does not retry a genuine read failure or replay a write with a transient-looking error", async () => {
  vi.useFakeTimers();
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  const snapshot = vi
    .spyOn(fixture.host, "snapshot")
    .mockRejectedValueOnce("Unreadable store");
  await control.refresh();
  expect(control.snapshot().status).toBe("error");
  await vi.advanceTimersByTimeAsync(5000);
  expect(snapshot).toHaveBeenCalledTimes(1);
  await control.refresh();
  const action = vi
    .spyOn(fixture.host, "action")
    .mockRejectedValue(transientRead);
  await expect(control.action(fixture.agent.id, "start")).rejects.toThrow(
    "Could not confirm",
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(action).toHaveBeenCalledTimes(1);
  expect(snapshot).toHaveBeenCalledTimes(2);
  expect(control.snapshot().status).toBe("error");
  control.dispose();
});
for (const boundary of ["dispose", "newer write"] as const) {
  it(`retires a waiting status read on ${boundary}`, async () => {
    vi.useFakeTimers();
    const fixture = controlFixture();
    const control = createAgentControl(fixture.host);
    await control.refresh();
    const snapshot = vi
      .spyOn(fixture.host, "snapshot")
      .mockRejectedValue(transientRead);
    const pending = control.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    if (boundary === "dispose") control.dispose();
    else await control.action(fixture.agent.id, "stop");
    const before = control.snapshot();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(control.snapshot()).toBe(before);
    if (boundary === "newer write") {
      expect(control.snapshot().data?.agents[0]?.status).toBe("stopped");
      expect(
        fixture.calls.filter((call) => call.action === "stop"),
      ).toHaveLength(1);
    }
    control.dispose();
  });
}
it("re-detects after a pending Stop settles without undoing its evidence", async () => {
  const fixture = controlFixture();
  fixture.data.harnessOptions?.push({
    command: "goose",
    label: "Goose",
    status: "cli-needed",
    providers: [],
  });
  const install = deferred<GooseInstallReport>();
  const stop = deferred<typeof fixture.data>();
  fixture.host.installGoose = () => install.promise;
  vi.spyOn(fixture.host, "action").mockReturnValue(stop.promise);
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const installing = control.installGoose?.();
  const stopping = control.action(fixture.agent.id, "stop");
  expect(control.snapshot().busy).toBe(true);
  const reads = fixture.calls.filter(
    (call) => call.action === "snapshot",
  ).length;
  install.resolve({
    ready: true,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/goose-install.log",
    output: "",
    error: null,
  });
  await installing;
  expect(control.snapshot().gooseInstall?.report?.ready).toBe(true);
  expect(
    fixture.calls.filter((call) => call.action === "snapshot"),
  ).toHaveLength(reads);
  fixture.agent.enabled = false;
  fixture.agent.status = "stopped";
  const goose = fixture.data.harnessOptions?.find(
    (option) => option.label === "Goose",
  );
  if (!goose) throw new Error("Missing Goose fixture");
  goose.status = "ready";
  stop.resolve(structuredClone(fixture.data));
  await stopping;
  await vi.waitFor(() =>
    expect(
      fixture.calls.filter((call) => call.action === "snapshot"),
    ).toHaveLength(reads + 1),
  );
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(false);
  expect(
    control
      .snapshot()
      .data?.harnessOptions?.find((option) => option.label === "Goose")?.status,
  ).toBe("ready");
  control.dispose();
});

it("waits out an earlier snapshot before reading the installed CLI again", async () => {
  const fixture = controlFixture();
  fixture.data.harnessOptions?.push({
    command: "goose",
    label: "Goose",
    status: "cli-needed",
    providers: [],
  });
  const install = deferred<GooseInstallReport>();
  fixture.host.installGoose = () => install.promise;
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const stale = deferred<typeof fixture.data>();
  const snapshot = fixture.host.snapshot.bind(fixture.host);
  const read = vi
    .spyOn(fixture.host, "snapshot")
    .mockImplementationOnce(() => stale.promise)
    .mockImplementation(snapshot);
  const pendingRead = control.refresh();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const installing = control.installGoose?.();
  install.resolve({
    ready: true,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/goose-install.log",
    output: "",
    error: null,
  });
  const goose = fixture.data.harnessOptions?.find(
    (option) => option.label === "Goose",
  );
  if (!goose) throw new Error("Missing Goose fixture");
  goose.status = "ready";
  stale.resolve({ ...structuredClone(fixture.data), harnessOptions: [] });
  await pendingRead;
  await installing;
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    control
      .snapshot()
      .data?.harnessOptions?.find((option) => option.label === "Goose")?.status,
  ).toBe("ready");
  control.dispose();
});

it("clears the previous Goose install report on retry and rejects a busy agent lane", async () => {
  const fixture = controlFixture();
  const retry = deferred<GooseInstallReport>();
  const install = vi
    .fn()
    .mockResolvedValueOnce({
      ready: false,
      restarted: 0,
      restartFailures: 0,
      logPath: "/fixture/goose-install.log",
      output: "failure",
      error: "Failed",
    })
    .mockImplementationOnce(() => retry.promise);
  fixture.host.installGoose = install;
  const control = createAgentControl(fixture.host);
  await control.refresh();
  await control.installGoose?.();
  expect(control.snapshot().gooseInstall?.report?.error).toBe("Failed");
  const action = deferred<typeof fixture.data>();
  vi.spyOn(fixture.host, "action").mockReturnValue(action.promise);
  const stopping = control.action(fixture.agent.id, "stop");
  await expect(control.installGoose?.()).rejects.toThrow("Refresh");
  expect(install).toHaveBeenCalledTimes(1);
  action.resolve(structuredClone(fixture.data));
  await stopping;
  const installing = control.installGoose?.();
  expect(control.snapshot().gooseInstall).toEqual({
    installing: true,
    report: null,
    error: null,
  });
  retry.resolve({
    ready: true,
    restarted: 1,
    restartFailures: 0,
    logPath: "/fixture/goose-install.log",
    output: "done",
    error: null,
  });
  await installing;
  expect(control.snapshot().gooseInstall?.report?.restarted).toBe(1);
  control.dispose();
});

it("keeps Stop available while Goose installs and refreshes once it settles", async () => {
  const fixture = controlFixture();
  const install = deferred<{
    ready: boolean;
    restarted: number;
    restartFailures: number;
    logPath: string;
    output: string;
    error: string | null;
  }>();
  fixture.host.installGoose = () => install.promise;
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const installing = control.installGoose?.();
  expect(control.snapshot().gooseInstall?.installing).toBe(true);
  expect(control.snapshot().busy).toBe(false);
  expect(canStopAgent(control.snapshot(), "fixture-agent")).toBe(true);
  await control.action("fixture-agent", "stop");
  expect(fixture.calls).toContainEqual(
    expect.objectContaining({ action: "stop" }),
  );
  expect(control.snapshot().gooseInstall?.installing).toBe(true);
  await expect(control.installGoose?.()).rejects.toThrow("in progress");
  const reads = fixture.calls.filter((c) => c.action === "snapshot").length;
  install.resolve({
    ready: true,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/goose-install.log",
    output: "",
    error: null,
  });
  await installing;
  expect(control.snapshot().gooseInstall?.report?.ready).toBe(true);
  expect(fixture.calls.filter((c) => c.action === "snapshot")).toHaveLength(
    reads + 1,
  );
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(false);
  control.dispose();
});

for (const status of ["waiting", "starting"] as const) {
  it(`attaches the earliest mention floor to a native ${status} launch without duplicate Start`, async () => {
    const fixture = controlFixture();
    fixture.host.attachMention = vi.fn(async () => {});
    fixture.agent.status = status;
    const control = createAgentControl(fixture.host);
    await control.refresh();
    await control.prepareMention(
      [fixture.agent.pubkey],
      fixture.agent.relayUrl,
      100,
      new AbortController().signal,
    )(90);
    expect(fixture.host.attachMention).toHaveBeenCalledExactlyOnceWith(
      fixture.agent.id,
      fixture.agent.revision,
      90,
    );
    expect(control.snapshot().mentionError).toBeUndefined();
    expect(
      fixture.calls.filter((call) => call.action === "start"),
    ).toHaveLength(0);
    control.dispose();
  });
}

it("runs Pi installation outside agent writes, fences Goose, and preserves the report after Stop", async () => {
  const fixture = controlFixture();
  const install = deferred<GooseInstallReport>();
  const goose = vi.fn();
  fixture.host.installPi = () => install.promise;
  fixture.host.installGoose = goose;
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const installing = control.installPi?.();
  expect(control.snapshot().piInstall?.installing).toBe(true);
  expect(control.snapshot().busy).toBe(false);
  expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
  await expect(control.installGoose?.()).rejects.toThrow("in progress");
  await control.action(fixture.agent.id, "stop");
  expect(fixture.calls).toContainEqual(
    expect.objectContaining({ action: "stop" }),
  );
  const reads = fixture.calls.filter(
    (call) => call.action === "snapshot",
  ).length;
  install.resolve({
    ready: true,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/pi-install.log",
    output: "done",
    error: null,
  });
  await installing;
  expect(control.snapshot().piInstall?.report?.ready).toBe(true);
  expect(control.snapshot().data?.agents[0]?.enabled).toBe(false);
  expect(
    fixture.calls.filter((call) => call.action === "snapshot"),
  ).toHaveLength(reads + 1);
  expect(goose).not.toHaveBeenCalled();
  control.dispose();
});

for (const operation of ["save", "saveDefaults"] as const) {
  it(`${operation} restart credential wait admits Stop and drops the late result`, async () => {
    const fixture = controlFixture();
    const before = structuredClone(fixture.data);
    const saved = structuredClone(before);
    saved.restarted = 1;
    const gate = deferred<void>();
    const started = deferred<void>();
    const write = vi.fn(async () => {
      started.resolve();
      await gate.promise;
      return saved;
    });
    fixture.host.save = write;
    fixture.host.saveDefaults = write;
    const stopped = structuredClone(before);
    stopped.agents[0] = {
      ...fixture.agent,
      enabled: false,
      status: "stopped",
      runningRevision: null,
    };
    const action = vi.spyOn(fixture.host, "action").mockResolvedValue(stopped);
    const control = createAgentControl(fixture.host);
    await control.refresh();
    const pending = (
      operation === "save"
        ? control.save(
            fixture.agent.id,
            fixture.agent.revision,
            agentEdit(agentDraft(fixture.agent)),
          )
        : control.saveDefaults?.({
            harness: "buzz-agent",
            provider: "",
            model: "next",
            effort: "",
            sessionPolicy: "channel",
            environment: {},
          })
    )?.catch((error: Error) => error);
    await started.promise;
    expect(control.snapshot().busy).toBe(true);
    expect(canStopAgent(control.snapshot(), fixture.agent.id)).toBe(true);
    await control.action(fixture.agent.id, "stop");
    expect(action).toHaveBeenCalledExactlyOnceWith(fixture.agent.id, "stop");
    expect(control.snapshot().data?.agents[0]?.status).toBe("stopped");
    gate.resolve();
    expect(await pending).toBeInstanceOf(Error);
    // The superseded save cannot overwrite the newer Stop's evidence.
    expect(control.snapshot().data?.agents[0]?.status).toBe("stopped");
    expect(control.snapshot().busy).toBe(false);
    control.dispose();
  });
}

for (const supported of [true, false]) {
  it(`warns when a pending launch cannot attach replay (supported=${supported})`, async () => {
    const fixture = controlFixture();
    fixture.agent.status = "waiting";
    if (supported)
      fixture.host.attachMention = vi.fn(async () => {
        throw new Error("RAW SECRET");
      });
    const control = createAgentControl(fixture.host);
    await control.prepareMention(
      [fixture.agent.pubkey],
      fixture.agent.relayUrl,
      100,
      new AbortController().signal,
    )();
    expect(control.snapshot().mentionError).toContain(
      "pending launch could not confirm replay",
    );
    expect(control.snapshot().mentionError).not.toContain("RAW SECRET");
    expect(
      fixture.calls.filter((call) => call.action === "start"),
    ).toHaveLength(0);
    control.dispose();
  });
}
it("Stop retires a late replay-attachment failure without overwriting its result", async () => {
  const fixture = controlFixture();
  fixture.agent.status = "waiting";
  const attached = deferred<void>();
  fixture.host.attachMention = vi.fn(async () => {
    await attached.promise;
    throw new Error("cancelled");
  });
  const control = createAgentControl(fixture.host);
  const wake = control.prepareMention(
    [fixture.agent.pubkey],
    fixture.agent.relayUrl,
    100,
    new AbortController().signal,
  )();
  await vi.waitFor(() =>
    expect(fixture.host.attachMention).toHaveBeenCalledOnce(),
  );
  await control.action(fixture.agent.id, "stop");
  attached.resolve();
  await wake;
  expect(control.snapshot().data?.agents[0]?.status).toBe("stopped");
  expect(control.snapshot().mentionError).toBeUndefined();
  control.dispose();
});
