import { expect, it } from "vitest";
import { isNativeMediaSource } from "./attachment-source";

const media = `https://relay.test/media/${"a".repeat(64)}.thumb.jpg`;
it.each(["buzz-media://localhost", "http://buzz-media.localhost"])(
  "recognizes exact %s media sources",
  (origin) => {
    expect(isNativeMediaSource(`${origin}/${encodeURIComponent(media)}`)).toBe(
      true,
    );
  },
);
it.each([
  `buzz-media://evil.test/${encodeURIComponent(media)}`,
  `https://buzz-media.localhost/${encodeURIComponent(media)}`,
  `http://buzz-media.localhost.evil.test/${encodeURIComponent(media)}`,
  `buzz-media://localhost:123/${encodeURIComponent(media)}`,
  `buzz-media://localhost/${encodeURIComponent(media)}?url=evil`,
  `buzz-media://localhost/${encodeURIComponent(media)}#fragment`,
  `buzz-media://localhost/${encodeURIComponent("https://relay.test/other")}`,
  `buzz-media://localhost/${encodeURIComponent("https://evil.test/media/../../../secret")}`,
  `buzz-media://localhost/${encodeURIComponent(`http://relay.test/media/${"a".repeat(64)}`)}`,
  `buzz-media://localhost/${encodeURIComponent(`https://user:pass@relay.test/media/${"a".repeat(64)}`)}`,
  "buzz-media://localhost/%invalid",
  "javascript:alert(1)",
])("rejects untrusted native lookalike %s", (source) => {
  expect(isNativeMediaSource(source)).toBe(false);
});
