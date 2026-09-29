//! Bounded conversion of uploaded HEIC and video bytes. No paths or ffmpeg
//! arguments are accepted from the webview; the result is uploaded by relay.rs.
use std::sync::OnceLock;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    process::Command,
    sync::{oneshot, Semaphore},
};

const MAX_INPUT: usize = 500 * 1024 * 1024;
const MAX_IMAGE: u64 = 50 * 1024 * 1024;
const MAX_VIDEO: u64 = 500 * 1024 * 1024;

fn allowed_mode(mode: &str, bytes: &[u8]) -> Option<(&'static str, bool, bool)> {
    let header = &bytes[..bytes.len().min(4096)];
    let brand = header.get(8..12);
    let mov = header.get(4..8) == Some(b"ftyp")
        && matches!(
            brand,
            Some(
                b"qt  "
                    | b"M4V "
                    | b"avc1"
                    | b"dash"
                    | b"iso2"
                    | b"iso3"
                    | b"iso4"
                    | b"iso5"
                    | b"iso6"
                    | b"isom"
                    | b"mmp4"
                    | b"mp41"
                    | b"mp42"
                    | b"mp4v"
                    | b"mp71"
                    | b"MSNV"
                    | b"NDAS"
                    | b"NDSc"
                    | b"NDSC"
                    | b"F4V "
                    | b"F4P "
            )
        );

    let heic = header.get(4..8) == Some(b"ftyp")
        && header
            .get(8..32.min(header.len()))
            .unwrap_or_default()
            .chunks(4)
            .any(|b| {
                matches!(
                    b,
                    b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1"
                )
            });
    match mode {
        "image:mov" if heic => Some(("mov", true, false)),
        "video:mov"
            if mov && !heic && !matches!(brand, Some(b"M4A " | b"M4B " | b"avif" | b"avis")) =>
        {
            Some(("mov", false, false))
        }
        "video:avi" if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"AVI ") => {
            Some(("avi", false, false))
        }
        "video:matroska" if header.starts_with(b"\x1a\x45\xdf\xa3") => {
            Some(("matroska", false, false))
        }
        "video:flv" if header.starts_with(b"FLV") => Some(("flv", false, false)),
        "video:asf" if header.starts_with(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9") => {
            Some(("asf", false, false))
        }
        "video:mpeg"
            if header.starts_with(b"\x00\x00\x01")
                && header.get(3).is_some_and(|b| (0xba..=0xbf).contains(b)) =>
        {
            Some(("mpeg", false, false))
        }
        "video:m4v"
            if header.starts_with(b"\x00\x00\x01")
                && header
                    .get(3)
                    .is_some_and(|b| matches!(b, 0xb0 | 0xb1 | 0xb5 | 0xb6)) =>
        {
            Some(("m4v", false, false))
        }
        "video:mpegvideo"
            if header.starts_with(b"\x00\x00\x01")
                && header.get(3).is_some_and(|b| (0xb2..=0xb9).contains(b)) =>
        {
            Some(("mpegvideo", false, false))
        }
        "voice:wav"
            if header.starts_with(b"RIFF")
                && header.get(8..12) == Some(b"WAVE")
                && bytes.len() <= 128 * 1024 * 1024 =>
        {
            Some(("wav", false, true))
        }
        "voice:flac" if header.starts_with(b"fLaC") && bytes.len() <= 128 * 1024 * 1024 => {
            Some(("flac", false, true))
        }
        "voice:ogg" if header.starts_with(b"OggS") && bytes.len() <= 128 * 1024 * 1024 => {
            Some(("ogg", false, true))
        }
        "voice:aiff"
            if header.starts_with(b"FORM")
                && matches!(header.get(8..12), Some(b"AIFF" | b"AIFC"))
                && bytes.len() <= 128 * 1024 * 1024 =>
        {
            Some(("aiff", false, true))
        }
        "voice:mp3" if header.starts_with(b"ID3") && bytes.len() <= 128 * 1024 * 1024 => {
            Some(("mp3", false, true))
        }
        "voice:aac" if header.first() == Some(&0xff) && bytes.len() <= 128 * 1024 * 1024 => {
            Some(("aac", false, true))
        }
        "voice:amr" if header.starts_with(b"#!AMR") && bytes.len() <= 128 * 1024 * 1024 => {
            Some(("amr", false, true))
        }
        "voice:mov"
            if header.get(4..8) == Some(b"ftyp")
                && matches!(brand, Some(b"M4A " | b"M4B " | b"F4A " | b"F4B "))
                && bytes.len() <= 128 * 1024 * 1024 =>
        {
            Some(("mov", false, true))
        }
        _ => None,
    }
}

fn output_size(path: &Path, limit: u64) -> Result<(), &'static str> {
    if path.metadata().is_ok_and(|meta| meta.len() > limit) {
        Err("size")
    } else {
        Ok(())
    }
}

pub(super) async fn prepare(
    body: Vec<u8>,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(Vec<u8>, &'static str), &'static str> {
    if body.is_empty() || body.len() > MAX_INPUT {
        return Err("size");
    }
    let (demuxer, image, voice) = allowed_mode(mode, &body).ok_or("video")?;
    if cancelled.try_recv().is_ok() {
        return Err("video");
    }
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    let _slot = SLOTS
        .get_or_init(|| Semaphore::new(2))
        .try_acquire()
        .map_err(|_| "capacity")?;
    let directory = tempfile::tempdir().map_err(|_| "capacity")?;
    let source = directory.path().join("source");
    let output = directory.path().join(if image {
        "prepared.jpg"
    } else {
        "prepared.mp4"
    });
    // File writes can be large; keep the async executor responsive.
    tokio::task::spawn_blocking(move || std::fs::write(source, body))
        .await
        .map_err(|_| "capacity")?
        .map_err(|_| "capacity")?;
    if cancelled.try_recv().is_ok() {
        return Err("video");
    }
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-y", "-nostdin", "-loglevel", "error"]);
    if voice {
        cmd.args(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1"]);
    }
    cmd.args(["-protocol_whitelist", "file,pipe", "-f", demuxer]);
    if demuxer == "mov" {
        cmd.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    cmd.arg("-i").arg(directory.path().join("source"));
    if image {
        cmd.args([
            "-map",
            "0:v:0",
            "-map_metadata",
            "-1",
            "-frames:v",
            "1",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-q:v",
            "2",
        ]);
    } else {
        cmd.args([
            "-map",
            "0:v:0",
            "-map",
            if voice { "1:a:0" } else { "0:a:0?" },
        ]);
        if voice {
            cmd.arg("-shortest");
        }
        cmd.args([
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-sn",
            "-dn",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-flags:a",
            "+bitexact",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-metadata",
            "encoder=",
        ]);
    }
    cmd.arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("LANG", "C");
    #[cfg(windows)]
    cmd.env(
        "SystemRoot",
        std::env::var_os("SystemRoot").unwrap_or_default(),
    );
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "ffmpeg"
        } else {
            "video"
        }
    })?;
    let deadline = tokio::time::sleep(Duration::from_secs(if image { 60 } else { 600 }));
    tokio::pin!(deadline);
    let mut monitor = tokio::time::interval(Duration::from_millis(250));
    let limit = if image { MAX_IMAGE } else { MAX_VIDEO };
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|_| "video"),
            _ = &mut *cancelled => { child.kill().await.ok(); return Err("video"); },
            _ = &mut deadline => { child.kill().await.ok(); return Err("video"); },
            _ = monitor.tick() => if output_size(&output, limit).is_err() { child.kill().await.ok(); return Err("size"); },
        }
    }?;
    if !status.success() {
        return Err(if image { "image" } else { "video" });
    }
    let size = output.metadata().map_err(|_| "video")?.len();
    if size == 0 || size > limit {
        return Err("size");
    }
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(output))
        .await
        .map_err(|_| "video")?
        .map_err(|_| "video")?;
    if bytes.len() as u64 != size {
        return Err("video");
    }
    if cancelled.try_recv().is_ok() {
        return Err("video");
    }
    Ok((bytes, if image { "image/jpeg" } else { "video/mp4" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn converts_video_with_fixed_demuxer_and_strips_input_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.avi");
        let generated = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=16x16:r=1",
                "-t",
                "1",
                "-metadata",
                "comment=private",
                "-c:v",
                "mpeg4",
            ])
            .arg(&input)
            .status();
        match generated {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            other => assert!(other.unwrap().success()),
        }
        let bytes = std::fs::read(input).unwrap();
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "video:avi", &mut cancelled).await.unwrap();
        assert_eq!(mime, "video/mp4");
        assert!(prepared.windows(4).any(|chunk| chunk == b"ftyp"));
        assert!(!prepared.windows(7).any(|chunk| chunk == b"private"));
    }

    #[test]
    fn modes_reject_arbitrary_ffmpeg_input_and_cross_type_claims() {
        assert!(allowed_mode("image:mov", b"unrecognized").is_none());
        assert!(allowed_mode("video:concat", b"ftyp").is_none());
        assert!(allowed_mode("video:mov", b"\0\0\0\x18ftypheic").is_none());
        assert_eq!(
            allowed_mode("image:mov", b"\0\0\0\x18ftypheic"),
            Some(("mov", true, false))
        );
    }
}
