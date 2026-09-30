import { expect, it } from "vitest";
import {
  audioDemuxer,
  isHeic,
  isVoiceNote,
  videoDemuxer,
} from "./video-preparation";
const bytes = (text: string) =>
  Uint8Array.from(text, (char) => char.charCodeAt(0));
const bmff = (brand: string) => bytes(`\0\0\0\x14ftyp${brand}\0\0\0\0${brand}`);
it.each(["qt  ", "isom", "iso2", "mp42", "M4V ", "avc1", "F4V "])(
  "prepares recognized BMFF video %s",
  (brand) => {
    expect(videoDemuxer(bmff(brand))).toBe("mov");
  },
);
it.each(["M4VH", "M4VP", "NDSS", "NSDC"])(
  "accepts legacy MOV video brand %s",
  (brand) => expect(videoDemuxer(bmff(brand))).toBe("mov"),
);
it.each(["free", "wide", "skip"])("skips leading %s MOV box", (box) => {
  expect(
    videoDemuxer(bytes(`\0\0\0\x08${box}\0\0\0\x14ftypqt  \0\0\0\0`)),
  ).toBe("mov");
});
it.each(["moov", "mdat"])("recognizes legacy %s MOV box", (box) => {
  expect(videoDemuxer(bytes(`\0\0\0\x0c${box}\0\0\0\0`))).toBe("mov");
});
it.each(["M4A ", "M4B ", "F4A ", "zzzz", "avif", "heic", "mif1"])(
  "does not turn audio/still/unknown BMFF %s into video",
  (brand) => {
    expect(videoDemuxer(bmff(brand))).toBeUndefined();
  },
);
it.each([
  ["RIFF\0\0\0\0AVI ", "avi"],
  ["\x1a\x45\xdf\xa3", "matroska"],
  ["FLV\x01", "flv"],
  ["\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9", "asf"],
  ["\0\0\x01\xba", "mpeg"],
  ["\0\0\x01\xb3", "mpegvideo"],
  ["\0\0\x01\xb0", "m4v"],
])("selects a fixed demuxer for %s", (input, expected) =>
  expect(videoDemuxer(bytes(input))).toBe(expected),
);
it("keeps HEIC and the named voice-note exception separate from ordinary audio", () => {
  expect(isHeic(bmff("heic"))).toBe(true);
  expect(isHeic(bmff("zzzz"), "PHOTO.HEIF")).toBe(true);
  expect(isHeic(bmff("isom"))).toBe(false);
  expect(isVoiceNote("Voice-Note-123.WAV")).toBe(true);
  expect(isVoiceNote("music.wav")).toBe(false);
  expect(audioDemuxer(bytes("RIFF\0\0\0\0WAVE"))).toBe("wav");
  expect(audioDemuxer(bmff("M4A "))).toBe("mov");
  expect(audioDemuxer(bmff("isom"))).toBeUndefined();
});
