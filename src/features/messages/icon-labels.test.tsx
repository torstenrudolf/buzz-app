// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MediaAttachment } from "./MediaAttachment";
import { downloadNativeMedia } from "./native-download";
import { ImageReviewStage } from "./ImageReviewStage";
vi.mock("./native-download", () => ({ downloadNativeMedia: vi.fn() }));
afterEach(cleanup);
it("keeps playback controls named for their actions, not icon components", () => {
  const { container } = render(
    <MediaAttachment
      attachment={{ url: "https://example.test/a.mp4", kind: "video" }}
      media={(url) => url}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing player");
  fireEvent.play(video);
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
});
it("keeps proxy images as downloads", () => {
  const url = "https://example.test/a.png";
  const source = "/api/relay/media?url=https%3A%2F%2Fexample.test%2Fa.png";
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => source}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const link = screen.getByRole("link", { name: "Download image" });
  expect(link).toHaveAttribute("href", source);
  expect(link).toHaveAttribute("download", "");
  expect(
    screen.queryByRole("link", { name: "Open image in browser" }),
  ).toBeNull();
});

it("opens external images through the host opener without download semantics", () => {
  const url = "https://example.test/a.png";
  const open = vi.fn(() => true);
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
      onOpenLink={open}
    />,
  );
  const link = screen.getByRole("link", { name: "Open image in browser" });
  expect(link).toHaveAttribute("href", url);
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(link).not.toHaveAttribute("download");
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledWith(url);
});

it("keeps external image fallback navigation when the host does not handle it", () => {
  const url = "https://example.test/unhandled.png";
  const open = vi.fn(() => false);
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
      onOpenLink={open}
    />,
  );
  expect(
    fireEvent.click(
      screen.getByRole("link", { name: "Open image in browser" }),
    ),
  ).toBe(true);
  expect(open).toHaveBeenCalledWith(url);
});

it("lets modified external image clicks use native browser behavior", () => {
  const url = "https://example.test/a.png";
  const open = vi.fn(() => true);
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={(url) => url}
      select={() => {}}
      onOpenLink={open}
    />,
  );
  fireEvent.click(screen.getByRole("link", { name: "Open image in browser" }), {
    metaKey: true,
  });
  expect(open).not.toHaveBeenCalled();
});

it("omits the image action for unsafe or missing sources", () => {
  const url = "https://example.test/a.png";
  const { rerender } = render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => "blob:https://example.test/a.png"}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  expect(screen.queryByRole("link")).toBeNull();
  rerender(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => undefined}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
  expect(screen.queryByRole("link")).toBeNull();
});

it("does not render stray file attachments as images", () => {
  const { container } = render(
    <MediaAttachment
      attachment={{ url: "https://example.test/file.bin", kind: "file" }}
      media={(url) => url}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Attachment unavailable",
  );
  expect(container.querySelector("img")).toBeNull();
});

it.each(["buzz-media://localhost", "http://buzz-media.localhost"])(
  "offers native image download on %s",
  (origin) => {
    const url = `https://relay.test/media/${"a".repeat(64)}.png`;
    const source = `${origin}/${encodeURIComponent(url)}`;
    render(
      <ImageReviewStage
        attachments={[{ url, kind: "image" }]}
        selectedUrl={url}
        media={() => source}
        select={() => {}}
        onOpenLink={() => false}
      />,
    );
    vi.mocked(downloadNativeMedia).mockResolvedValue(undefined);
    const link = screen.getByRole("button", { name: "Download image" });
    expect(link).not.toHaveAttribute("href");
    fireEvent.click(link);
    expect(downloadNativeMedia).toHaveBeenCalledWith(source);
    expect(
      screen.queryByRole("link", { name: "Open image in browser" }),
    ).toBeNull();
  },
);

it("does not offer an image download for a native lookalike", () => {
  const url = "https://relay.test/image.png";
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() =>
        `buzz-media://evil.test/${encodeURIComponent(`https://relay.test/media/${"a".repeat(64)}.png`)}`
      }
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
});

it("reports native image download failures without navigating", async () => {
  const url = `https://relay.test/media/${"a".repeat(64)}.png`;
  vi.mocked(downloadNativeMedia).mockRejectedValueOnce(
    new Error("unavailable"),
  );
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image" }]}
      selectedUrl={url}
      media={() => `buzz-media://localhost/${encodeURIComponent(url)}`}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Download failed"),
  );
});
