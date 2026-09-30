import { invoke } from "@tauri-apps/api/core";

/** The host validates the URL again and owns the destination; never navigate the webview. */
export async function downloadNativeMedia(source: string, name = "") {
  await invoke("media_download", { source, name });
}
