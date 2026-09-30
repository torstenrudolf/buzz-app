/** Only the URLs emitted by convertFileSrc(relayMediaUrl, "buzz-media"). */
export function isNativeMediaSource(source: string): boolean {
  try {
    const url = new URL(source);
    if (
      !(
        (url.protocol === "buzz-media:" && url.hostname === "localhost") ||
        (url.protocol === "http:" && url.hostname === "buzz-media.localhost")
      ) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const encoded = url.pathname.slice(1);
    const target = decodeURIComponent(encoded);
    if (!encoded || encodeURIComponent(target) !== encoded) return false;
    const media = new URL(target);
    if (media.href !== target) return false;
    return (
      media.protocol === "https:" &&
      !media.username &&
      !media.password &&
      !media.search &&
      !media.hash &&
      /^\/media\/[0-9a-f]{64}(?:\.(?:[a-z0-9]{1,8}|thumb\.jpg))?$/.test(
        media.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function isProxySource(source: string): boolean {
  try {
    const hasWindow = typeof window !== "undefined";
    const url = new URL(
      source,
      hasWindow ? window.location.href : "https://app.test",
    );
    const sameOrigin =
      source.startsWith("/") ||
      (hasWindow && url.origin === window.location.origin);
    return (
      sameOrigin &&
      url.pathname.startsWith("/api/relay") &&
      url.pathname.endsWith("/media")
    );
  } catch {
    return false;
  }
}

export function safeOpenUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}
