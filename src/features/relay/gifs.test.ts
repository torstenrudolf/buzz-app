import { afterEach, describe, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { foldMessages } from "./fold";
import {
  communityFromScope,
  gifMarkdown,
  relaySupportsKlipy,
  fetchKlipyGifs,
  normalizeKlipyGifs,
  relayKlipySearchPath,
} from "./gifs";
import { keypair, message } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

test("native GIF search follows only the advertised relay route, never the broker", async () => {
  vi.stubGlobal("navigator", { platform: "MacIntel", language: "en-US" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No broker");
    }),
  );
  const paths: string[] = [];
  let search = "/gifs/search";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe("relay_http");
    const { community, path, body } = args as {
      community: string;
      path: string;
      body: string | null;
    };
    expect(community).toBe("https://native-gifs.test");
    paths.push(path);
    if (path === "/")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search },
        }),
      };
    expect(path).toBe("/gifs/search");
    expect(JSON.parse(body ?? "null")).toMatchObject({
      query: "wave",
      locale: "en-US",
    });
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ result: true, data: { data: [] } }),
    };
  });
  expect(await relaySupportsKlipy("https://native-gifs.test")).toBe(true);
  expect(await fetchKlipyGifs("https://native-gifs.test", " wave ")).toEqual(
    [],
  );
  expect(paths).toEqual(["/", "/", "/gifs/search"]);
  search = "https://other.test/gifs/search";
  await expect(
    fetchKlipyGifs("https://native-gifs.test", "wave"),
  ).rejects.toThrow("unavailable");
  expect(paths).toEqual(["/", "/", "/gifs/search", "/"]);
  expect(fetch).not.toHaveBeenCalled();
});

const asset = (url: string, width = 320, height = 180) => ({
  url,
  width,
  height,
  size: 1234,
});

describe("relay KLIPY capability", () => {
  test("accepts only the advertised relay-relative provider path", () => {
    expect(
      relayKlipySearchPath({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      }),
    ).toBe("/gifs/search");
    for (const search of [
      "https://provider.invalid/search",
      "//provider.invalid/search",
      "/gifs/../secret",
      "/gifs/search?key=secret",
      "/gifs/%2e%2e/secret",
    ])
      expect(
        relayKlipySearchPath({
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search },
        }),
      ).toBeNull();
  });

  test("requires both the extension and KLIPY provider", () => {
    expect(
      relayKlipySearchPath({
        supported_extensions: [],
        gif: { provider: "klipy", search: "/gifs/search" },
      }),
    ).toBeNull();
    expect(
      relayKlipySearchPath({
        supported_extensions: ["buzz-gif"],
        gif: { provider: "other", search: "/gifs/search" },
      }),
    ).toBeNull();
  });
});

test("communityFromScope separates an HTTPS community from its viewer", () => {
  const viewer = "a".repeat(64);
  expect(communityFromScope(`https://buzz.example:${viewer}`)).toBe(
    "https://buzz.example",
  );
  expect(communityFromScope(`http://buzz.example:${viewer}`)).toBeNull();
  expect(communityFromScope("not-a-session-scope")).toBeNull();
});

test("normalizes usable GIF records and rejects unsafe or incomplete media", () => {
  expect(
    normalizeKlipyGifs([
      {
        id: 7,
        type: "gif",
        slug: "hello",
        title: " Hello ",
        file: {
          md: { gif: asset("https://cdn.example/original.gif") },
          sm: { webp: asset("https://cdn.example/preview.webp", 160, 90) },
        },
      },
      {
        type: "gif",
        slug: "unsafe",
        file: { md: { gif: asset("http://cdn.example/unsafe.gif") } },
      },
      { type: "ad", slug: "advertisement", file: {} },
    ]),
  ).toEqual([
    {
      id: 7,
      slug: "hello",
      title: "Hello",
      original: asset("https://cdn.example/original.gif"),
      preview: asset("https://cdn.example/preview.webp", 160, 90),
    },
  ]);
});

test("gifMarkdown produces attachment syntax without malformed alt text", () => {
  expect(
    gifMarkdown({
      id: 1,
      slug: "wave",
      title: "Wave [hello]",
      original: asset("https://cdn.example/wave(test).gif"),
      preview: asset("https://cdn.example/wave.webp"),
    }),
  ).toBe("![Wave hello](https://cdn.example/wave%28test%29.gif)");
});

test("gifMarkdown folds to an image attachment without visible markdown body text", () => {
  const author = keypair();
  const relay = keypair();
  const markdown = gifMarkdown({
    id: 1,
    slug: "wave",
    title: "Wave",
    original: asset("https://cdn.example/wave.gif"),
    preview: asset("https://cdn.example/wave.webp"),
  });

  const [row] = foldMessages("gifs", relay.pubkey, [
    message(author, "gifs", markdown, 1),
  ]);

  expect(row?.content).toBe("");
  expect(row?.attachmentContentRemoved).toBe(true);
  expect(row?.attachments).toEqual([
    { url: "https://cdn.example/wave.gif", kind: "image" },
  ]);
});
