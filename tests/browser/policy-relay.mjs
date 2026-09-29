import { expect } from "@playwright/test";
import { verifyEvent } from "nostr-tools";
import { createHash } from "node:crypto";

/** Model the relay boundaries that matter to this journey, not a replacement
 * session: AUTH, explicit channel fan-out, EOSE, CLOSED and HTTP quota reasons.
 * The production broker owns all pacing, signing, SSE and retry controls. */
export function policyRelay({
  viewer,
  relayAuthor,
  answer,
  report,
  pending,
  discovery,
  acceptPublication,
  latencyMs = 0,
  holdOlder = true,
}) {
  const sockets = [];
  let presenceHeld = false;
  const presenceWaiters = [];
  report.presenceSnapshots = [];
  report.presencePublications = [];
  const requests = [];
  const rejected = [];
  report.liveRequests = requests;
  report.quotaRefusals = rejected;
  const quotas = new Map();
  // Opt-in scale profile: the relay's per-principal, per-community Redis counter.
  // REQ and EVENT share a five-second window starting on the first frame;
  // rejected frames increment it too. AUTH/CLOSE do not spend this budget.
  let wsLimit = 0;
  let eoseMs = 0;
  const wsWindows = new Map();
  report.wsAdmissions = [];
  function admitWs(socket, kind, id) {
    if (!wsLimit || !["REQ", "EVENT"].includes(kind)) return true;
    const now = performance.now();
    let window = wsWindows.get(socket.community);
    if (!window || now >= window.reset) {
      window = { count: 0, reset: now + 5000 };
      wsWindows.set(socket.community, window);
    }
    const accepted = ++window.count <= wsLimit;
    report.wsAdmissions.push({
      kind,
      id: kind === "EVENT" ? id.id : id,
      community: socket.community,
      at: now,
      accepted,
    });
    if (!accepted) {
      // Redis TTL reports remaining milliseconds rounded to the nearest second.
      const seconds = Math.round((window.reset - now) / 1000);
      const reason = `rate-limited: quota exceeded; retry in ${seconds}s`;
      const reject = () =>
        emit(
          socket,
          kind === "REQ"
            ? ["CLOSED", id, reason]
            : ["OK", id.id, false, reason],
        );
      if (eoseMs) setTimeout(reject, eoseMs);
      else queueMicrotask(reject);
    }
    return accepted;
  }
  const heldEose = new Set();
  const pendingEose = [];
  const pendingProfiles = [];
  const pendingUnread = [];
  const unreadHolds = [];
  report.unreadHolds = unreadHolds;
  let heldUnread = false;
  const profileHolds = [];
  report.profileHolds = profileHolds;
  let heldAuthors = new Set();
  // Fixture targets distinguish the two explicit production globals from channels.
  const routeOf = (filter) =>
    filter["#h"]?.[0] ??
    (filter.kinds.length === 3 &&
    [0, 10100, 30177].every((kind) => filter.kinds.includes(kind))
      ? "profiles"
      : filter.kinds.includes(44100)
        ? "membership"
        : filter.kinds.includes(24200)
          ? "observer"
          : undefined);
  report.wireFrames = [];
  report.startupFrames = [];
  let emptyRoster = false;
  let heldContent = false;
  const communityOf = (url) =>
    String(url).includes("secondary") ? "secondary" : "primary";
  const fault = (error) => {
    report.unexpected.push(String(error));
    throw error;
  };
  function emit(socket, frame) {
    report.wireFrames.push(frame);
    if (wsLimit)
      report.startupFrames.push({
        socket: sockets.indexOf(socket),
        frame,
        at: performance.now(),
      });
    if (socket.readyState === 1)
      socket.onmessage?.({ data: JSON.stringify(frame) });
  }
  return {
    startupQuota(limit, setupLatencyMs = 40) {
      wsLimit = limit;
      eoseMs = setupLatencyMs;
    },
    holdPresence() {
      presenceHeld = true;
    },
    releasePresence() {
      presenceHeld = false;
      for (const release of presenceWaiters.splice(0)) release();
    },
    holdContent() {
      heldContent = true;
    },
    holdProfiles(authors) {
      heldAuthors = new Set(authors);
    },
    releaseProfiles() {
      heldAuthors.clear();
      for (const release of pendingProfiles.splice(0)) release();
    },
    holdUnread() {
      heldUnread = true;
    },
    releaseUnread() {
      heldUnread = false;
      for (const release of pendingUnread.splice(0)) release();
    },
    holdEose(channel) {
      heldEose.add(channel);
    },
    releaseEose(channel) {
      heldEose.delete(channel);
      for (let i = pendingEose.length - 1; i >= 0; i--) {
        const item = pendingEose[i];
        if (item.routes.some((route) => heldEose.has(route))) continue;
        pendingEose.splice(i, 1);
        if (item.socket.routes.has(item.id))
          emit(item.socket, ["EOSE", item.id]);
      }
    },
    sockets,
    requests,
    rejected,
    expectedHttpErrors: () => rejected.length > 0,
    /** The broker pauses its API lane for the advertised delay when it reads
     * the refusal, before the fixture stamps `relayed` on response finish.
     * Browser-side cooldowns need the page clock; see the retry specs. */
    brokerCooldownOver(index = 0) {
      const rejection = rejected[index];
      return (
        rejection?.relayed !== undefined &&
        performance.now() >= rejection.relayed + rejection.retryAfterMs
      );
    },
    emptyRoster() {
      emptyRoster = true;
    },
    quotaNextRoster(seconds = 1) {
      quotas.set("roster", seconds);
    },
    quotaNextHead(channel, seconds = 1) {
      quotas.set(channel, seconds);
    },
    quotaNextOlder(channel, seconds = 1) {
      quotas.set(`older:${channel}`, seconds);
    },
    async fetch(url, init) {
      try {
        if (latencyMs)
          await new Promise((resolve) => setTimeout(resolve, latencyMs));
        // NIP-11 is a public GET with no signed query body. The rail now reads
        // it for saved communities, including inactive ones.
        if (!init?.body) {
          expect(new URL(url).pathname).toBe("/");
          return Response.json(discovery?.(communityOf(url)) ?? {});
        }
        expect(["/query", ...(acceptPublication ? ["/events"] : [])]).toContain(
          new URL(url).pathname,
        );
        const auth = JSON.parse(
          Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
        );
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.pubkey).toBe(viewer);
        expect(auth.kind).toBe(27235);
        expect(auth.tags).toContainEqual(["u", String(url)]);
        expect(auth.tags).toContainEqual([
          "payload",
          createHash("sha256").update(init.body).digest("hex"),
        ]);
        const filters = JSON.parse(init.body);
        if (new URL(url).pathname === "/events") {
          acceptPublication(communityOf(url), filters);
          return Response.json({ accepted: true, event_id: filters.id });
        }
        if (filters.length === 2 && filters[1].depth_limit) {
          const [root, replies] = filters;
          expect(root).toEqual({
            ids: replies["#e"],
            "#h": replies["#h"],
            limit: 1,
          });
          expect(replies.kinds.toSorted((a, b) => a - b)).toEqual([
            9, 40002, 40008,
          ]);
          for (const filter of filters)
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (filters.length === 2 && filters[1].kinds?.includes(13534)) {
          // Identity archive consent: the target's profile plus the relay roster.
          expect(filters).toEqual([
            { kinds: [0], authors: [expect.any(String)], limit: 1 },
            { kinds: [13534], authors: [relayAuthor], limit: 1 },
          ]);
          for (const filter of filters)
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (filters.length === 2 && filters[0].kinds?.includes(39000)) {
          // Exact channel authority lookup, distinct from sidebar preferences.
          const ids = filters[0]["#d"];
          expect(Array.isArray(ids)).toBe(true);
          expect(ids.length).toBeGreaterThan(0);
          expect(ids.length).toBeLessThanOrEqual(128);
          expect(new Set(ids).size).toBe(ids.length);
          expect(filters).toEqual([
            {
              kinds: [39000],
              authors: [relayAuthor],
              "#d": ids,
              limit: ids.length + 1,
            },
            {
              kinds: [39002],
              authors: [relayAuthor],
              "#d": ids,
              "#p": [viewer],
              limit: ids.length + 1,
            },
          ]);
          const community = communityOf(url);
          for (const filter of filters)
            report.queries.push({ community, filter, at: performance.now() });
          return Response.json(
            filters.flatMap((filter) =>
              emptyRoster && filter.kinds.includes(39002)
                ? []
                : answer(community, filter),
            ),
          );
        }
        if (
          filters.length <= 128 &&
          filters.every(
            (filter) =>
              filter.limit === 1 &&
              filter["#h"]?.length === 1 &&
              [9, 40002, 40008, 45001, 45003].every((kind) =>
                filter.kinds?.includes(kind),
              ),
          )
        ) {
          for (const filter of filters)
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (
          filters.length === 3 &&
          filters.every(
            (filter) =>
              filter.kinds?.length === 1 &&
              [39000, 39001, 39002].includes(filter.kinds[0]),
          )
        ) {
          expect(filters.map((filter) => filter.kinds[0])).toEqual([
            39000, 39001, 39002,
          ]);
          expect(new Set(filters.map((filter) => filter["#d"]?.[0])).size).toBe(
            1,
          );
          for (const filter of filters) {
            expect(filter.limit).toBe(1);
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          }
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (filters.length !== 1) {
          // Sidebar preferences read only these four exact own-author coordinates.
          expect(filters).toHaveLength(4);
          expect(filters.map((filter) => filter["#d"]?.[0]).sort()).toEqual([
            "channel-mutes",
            "channel-sections",
            "channel-sort",
            "channel-stars",
          ]);
          for (const filter of filters) {
            expect(filter.kinds).toEqual([30078]);
            expect(filter.authors).toEqual([viewer]);
            expect(filter.limit).toBe(1);
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          }
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        const filter = filters[0],
          community = communityOf(url);
        report.queries.push({ community, filter, at: performance.now() });
        if (filter.kinds?.includes(20001)) {
          expect(Object.keys(filter).sort()).toEqual([
            "authors",
            "kinds",
            "limit",
          ]);
          expect(filter.authors.length).toBeGreaterThan(0);
          expect(filter.authors.length).toBeLessThanOrEqual(256);
          expect(filter.limit).toBe(filter.authors.length);
          const snapshot = {
            community,
            filter,
            pending: presenceHeld,
            aborted: false,
          };
          report.presenceSnapshots.push(snapshot);
          // Return the pending fetch, like the profile/content holds below.
          // Awaiting it inside the fixture assertion catch misclassifies normal
          // consumer cancellation as an unexpected protocol assertion failure.
          if (presenceHeld)
            return new Promise((resolve, reject) => {
              const abort = () => {
                snapshot.pending = false;
                snapshot.aborted = true;
                reject(init.signal.reason);
              };
              if (init.signal.aborted) return abort();
              presenceWaiters.push(() => {
                init.signal.removeEventListener("abort", abort);
                snapshot.pending = false;
                if (!snapshot.aborted)
                  resolve(Response.json(answer(community, filter)));
              });
              init.signal.addEventListener("abort", abort, { once: true });
            });
          return Response.json(answer(community, filter));
        }
        if (heldContent && filter.kinds?.includes(9))
          return new Promise((_resolve, reject) => {
            if (init.signal.aborted) reject(init.signal.reason);
            else
              init.signal.addEventListener(
                "abort",
                () => reject(init.signal.reason),
                { once: true },
              );
          });
        const channel = filter["#h"]?.[0];
        // Head catch-up is an exact top-level channel window, not a batched
        // sidebar preview that happens to contain that channel.
        const quota = filter.kinds?.includes(39002)
          ? "roster"
          : filter.kinds?.includes(9)
            ? filter.until === undefined
              ? filter["#h"]?.length === 1 && filter.top_level === true
                ? channel
                : undefined
              : `older:${channel}`
            : undefined;
        if (quotas.has(quota)) {
          const seconds = quotas.get(quota);
          quotas.delete(quota);
          rejected.push({
            channel,
            retryAfterMs: (seconds + 1) * 1000,
          });
          return Response.json(
            { error: `rate-limited: quota exceeded; retry in ${seconds}s` },
            { status: 429 },
          );
        }
        const result =
          emptyRoster && filter.kinds?.includes(39002)
            ? []
            : answer(community, filter);
        if (
          heldUnread &&
          filter.kinds?.includes(9) &&
          filter["#h"]?.length &&
          filter.top_level === undefined &&
          filter.depth_limit === undefined &&
          filter.until === undefined
        )
          return new Promise((resolve, reject) => {
            const held = { pending: true, aborted: false };
            unreadHolds.push(held);
            const abort = () => {
              held.pending = false;
              held.aborted = true;
              reject(init.signal.reason);
            };
            if (init.signal.aborted) return abort();
            init.signal.addEventListener("abort", abort, { once: true });
            pendingUnread.push(() => {
              held.pending = false;
              init.signal.removeEventListener("abort", abort);
              if (!held.aborted) resolve(Response.json(result));
            });
          });
        if (
          filter.kinds?.includes(0) &&
          filter.authors?.some((id) => heldAuthors.has(id))
        )
          return new Promise((resolve, reject) => {
            const held = { pending: true, aborted: false };
            profileHolds.push(held);
            const abort = () => {
              held.pending = false;
              held.aborted = true;
              reject(init.signal.reason);
            };
            init.signal.addEventListener("abort", abort, { once: true });
            pendingProfiles.push(() => {
              held.pending = false;
              init.signal.removeEventListener("abort", abort);
              resolve(Response.json(result));
            });
          });
        if (filter.until !== undefined && holdOlder)
          return new Promise((resolve, reject) => {
            const abort = () => reject(init.signal.reason);
            init.signal.addEventListener("abort", abort, { once: true });
            pending.push({
              community,
              channel,
              filter,
              events: result.filter((event) => event.kind === 9),
              release() {
                init.signal.removeEventListener("abort", abort);
                resolve(Response.json(result));
              },
            });
          });
        return Response.json(result);
      } catch (error) {
        return fault(error);
      }
    },
    socket(url) {
      const socket = {
        community: communityOf(url),
        readyState: 1,
        authenticated: false,
        routes: new Map(),
        send(text) {
          try {
            const [kind, id, ...filters] = JSON.parse(text);
            if (kind === "AUTH") {
              expect(verifyEvent(id)).toBe(true);
              expect(id.pubkey).toBe(viewer);
              expect(id.tags).toContainEqual(["challenge", "policy-fixture"]);
              this.authenticated = true;
              queueMicrotask(() => emit(this, ["OK", id.id, true]));
              return;
            }
            if (kind === "CLOSE") {
              this.routes.delete(id);
              return;
            }
            if (kind === "EVENT" && !admitWs(this, kind, id)) return;
            if (kind === "EVENT" && id.kind === 20001) {
              expect(this.authenticated).toBe(true);
              expect(verifyEvent(id)).toBe(true);
              expect(id.pubkey).toBe(viewer);
              expect(id.kind).toBe(20001);
              expect(["online", "away", "offline"]).toContain(id.content);
              expect(id.tags).toEqual([]);
              report.presencePublications.push({
                community: this.community,
                event: id,
                at: performance.now(),
              });
              queueMicrotask(() => {
                emit(this, ["OK", id.id, true]);
                for (const peer of sockets) {
                  if (peer.community !== this.community) continue;
                  for (const [wire, filters] of peer.routes)
                    if (
                      filters.some(
                        (filter) =>
                          filter.kinds.includes(20001) &&
                          filter.authors?.includes(id.pubkey),
                      )
                    )
                      emit(peer, ["EVENT", wire, id]);
                }
              });
              return;
            }
            if (kind === "EVENT" && acceptPublication) {
              expect(this.authenticated).toBe(true);
              setTimeout(() => {
                try {
                  acceptPublication(this.community, id);
                  emit(this, ["OK", id.id, true, ""]);
                } catch (error) {
                  fault(error);
                }
              }, latencyMs);
              return;
            }
            expect(
              kind,
              kind === "EVENT"
                ? `Unexpected publication kind ${id?.kind}`
                : `Unexpected relay frame ${kind}`,
            ).toBe("REQ");
            expect(this.authenticated).toBe(true);
            expect(filters.length).toBeGreaterThan(0);
            expect(filters.length).toBeLessThanOrEqual(10);
            const routes = filters.flatMap(
              (filter) => filter["#h"] ?? [routeOf(filter)],
            );
            requests.push({
              socket: sockets.indexOf(this),
              community: this.community,
              id,
              filters,
              routes,
              at: performance.now(),
            });
            if (!admitWs(this, kind, id)) return;
            for (const filter of filters) {
              const channel = filter["#h"]?.[0];
              // Initial replay stays per channel; zero replay may consolidate the wire.
              if (
                filter.kinds.includes(9) &&
                (!channel ||
                  filter["#h"].length > 10 ||
                  (filter.limit !== 0 && filter["#h"].length !== 1))
              ) {
                queueMicrotask(() =>
                  emit(this, [
                    "CLOSED",
                    id,
                    "restricted: channel filter required",
                  ]),
                );
                return;
              }
              if (filter.kinds.includes(44100))
                expect(filter["#p"]).toEqual([viewer]);
              if (filter.kinds.includes(24200)) {
                expect(filter["#p"]).toEqual([viewer]);
                expect(filter["#h"]).toBeUndefined();
                expect(filter.limit).toBeUndefined();
                expect(filter.since).toBeGreaterThanOrEqual(
                  Math.floor(Date.now() / 1000) - 1,
                );
              }
            }
            this.routes.set(id, filters);
            if (routes.some((route) => heldEose.has(route)))
              pendingEose.push({ socket: this, id, routes });
            else if (eoseMs) setTimeout(() => emit(this, ["EOSE", id]), eoseMs);
            else queueMicrotask(() => emit(this, ["EOSE", id]));
          } catch (error) {
            fault(error);
          }
        },
        close() {
          this.readyState = 3;
          this.routes.clear();
          this.onclose?.();
        },
      };
      sockets.push(socket);
      queueMicrotask(() => emit(socket, ["AUTH", "policy-fixture"]));
      return socket;
    },
    hasRoute(community, channel) {
      return sockets.some(
        (s) =>
          s.readyState === 1 &&
          s.community === community &&
          [...s.routes.values()].some((filters) =>
            filters.some((filter) =>
              (filter["#h"] ?? [routeOf(filter)]).includes(channel),
            ),
          ),
      );
    },
    presence(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of socket.routes) {
          if (
            !filters.some(
              (filter) =>
                filter.kinds.includes(20001) &&
                filter.authors?.includes(event.pubkey),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "presence must traverse the production demand-scoped REQ",
      ).toBeGreaterThan(0);
    },
    observer(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of socket.routes) {
          if (
            !filters.some(
              (filter) =>
                filter.kinds.includes(24200) && filter["#p"]?.includes(viewer),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "observer must traverse the production owner-only route",
      ).toBeGreaterThan(0);
    },
    publish(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of socket.routes) {
          if (
            !filters.some(
              (filter) =>
                filter.kinds.includes(event.kind) &&
                filter["#h"]?.some((h) =>
                  event.tags.some(([k, v]) => k === "h" && h === v),
                ),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "event must traverse an explicit production channel REQ",
      ).toBeGreaterThan(0);
    },
    failRoute(
      community,
      channel,
      reason = "temporary: fixture stream interrupted",
    ) {
      let failures = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filters] of [...socket.routes]) {
          if (
            !filters.some((filter) =>
              (filter["#h"] ?? [routeOf(filter)]).includes(channel),
            )
          )
            continue;
          socket.routes.delete(id);
          emit(socket, ["CLOSED", id, reason]);
          failures++;
        }
      }
      expect(failures).toBeGreaterThan(0);
    },
    disconnect(community) {
      for (const socket of sockets)
        if (socket.community === community && socket.readyState === 1)
          socket.close();
    },
  };
}
