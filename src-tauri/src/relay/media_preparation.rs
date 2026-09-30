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

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PreparationError {
    Size,
    Capacity,
    Ffmpeg,
    Image,
    Video,
    Io,
    Cancelled,
}

impl PreparationError {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Size => "size",
            Self::Capacity => "capacity",
            Self::Ffmpeg => "ffmpeg",
            Self::Image => "image",
            Self::Video => "video",
            Self::Io => "io",
            Self::Cancelled => "cancelled",
        }
    }

    pub(super) fn status(&self) -> u16 {
        match self {
            Self::Size => 413,
            Self::Capacity => 429,
            Self::Ffmpeg => 503,
            _ => 400,
        }
    }
}

// Match videoDemuxer's bounded box walk. No URL, path, or demuxer comes from the webview.
fn mov_brand(header: &[u8]) -> Option<Option<&[u8]>> {
    let mut offset = 0;
    while offset + 12 <= header.len() {
        let kind = &header[offset + 4..offset + 8];
        if kind == b"ftyp" {
            let size = u32::from_be_bytes(header[offset..offset + 4].try_into().ok()?) as usize;
            let end = offset.saturating_add(size).min(header.len());
            if end < offset + 12 {
                return None;
            }
            let mut brand = offset + 8;
            while brand + 4 <= end {
                if matches!(
                    &header[brand..brand + 4],
                    b"heic"
                        | b"heix"
                        | b"hevc"
                        | b"hevx"
                        | b"heim"
                        | b"heis"
                        | b"mif1"
                        | b"msf1"
                        | b"avif"
                        | b"avis"
                ) {
                    return None;
                }
                brand += if brand == offset + 8 { 8 } else { 4 };
            }
            return Some(Some(&header[offset + 8..offset + 12]));
        }
        if kind == b"moov" || kind == b"mdat" {
            return Some(None);
        }
        if !matches!(kind, b"wide" | b"free" | b"skip") {
            break;
        }
        let size = u32::from_be_bytes(header[offset..offset + 4].try_into().ok()?) as usize;
        if size < 8 {
            break;
        }
        offset = offset.saturating_add(size);
    }
    None
}

fn allowed_mode(mode: &str, bytes: &[u8]) -> Option<(&'static str, bool, bool)> {
    let header = &bytes[..bytes.len().min(4096)];
    let brand = header.get(8..12);
    let mov = match mov_brand(header) {
        Some(None) => true,
        Some(Some(brand)) => {
            matches!(
                brand,
                b"qt  "
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
                    | b"NDSC"
                    | b"NDSH"
                    | b"NDSM"
                    | b"NDSP"
                    | b"NDSS"
                    | b"NSDC"
                    | b"NDXC"
                    | b"NDXH"
                    | b"NDXM"
                    | b"NDXP"
                    | b"NDXS"
                    | b"F4V "
                    | b"F4P "
            ) || brand.starts_with(b"M4V")
        }
        None => false,
    };

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
        // A .heic filename alone is not proof of a still image: reject unfamiliar
        // brands instead of allowing the webview to select arbitrary MOV input.
        "image:mov" if heic => Some(("mov", true, false)),
        "video:mov" if mov && !heic => Some(("mov", false, false)),
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
        "voice:mp3"
            if (header.starts_with(b"ID3")
                || header.first() == Some(&0xff)
                    && header
                        .get(1)
                        .is_some_and(|b| b & 0xe0 == 0xe0 && b & 6 != 0))
                && bytes.len() <= 128 * 1024 * 1024 =>
        {
            Some(("mp3", false, true))
        }
        "voice:aac"
            if header.first() == Some(&0xff)
                && header.get(1).is_some_and(|b| b & 0xf6 == 0xf0)
                && bytes.len() <= 128 * 1024 * 1024 =>
        {
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

fn private_tempdir_in(parent: &Path) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Set permissions during creation: the source must never become readable
        // through a shared temporary parent, even briefly.
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

pub(super) async fn prepare(
    body: Vec<u8>,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(Vec<u8>, &'static str), PreparationError> {
    if body.is_empty() || body.len() > MAX_INPUT {
        return Err(PreparationError::Size);
    }
    let (demuxer, image, voice) =
        allowed_mode(mode, &body).ok_or(if mode.starts_with("image:") {
            PreparationError::Image
        } else {
            PreparationError::Video
        })?;
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    let _slot = SLOTS
        .get_or_init(|| Semaphore::new(2))
        .try_acquire()
        .map_err(|_| PreparationError::Capacity)?;
    let directory = private_tempdir_in(&std::env::temp_dir()).map_err(|_| PreparationError::Io)?;
    let source = directory.path().join("source");
    let output = directory.path().join(if image {
        "prepared.jpg"
    } else {
        "prepared.mp4"
    });
    // File writes can be large; keep the async executor responsive.
    tokio::task::spawn_blocking(move || std::fs::write(source, body))
        .await
        .map_err(|_| PreparationError::Io)?
        .map_err(|_| PreparationError::Io)?;
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    let path = crate::host_command::effective_path();
    let mut cmd = Command::new(crate::host_command::resolve_program("ffmpeg", &path));
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
    cmd.env_clear().env("PATH", path).env("LANG", "C");
    #[cfg(windows)]
    cmd.env(
        "SystemRoot",
        std::env::var_os("SystemRoot").unwrap_or_default(),
    );
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            PreparationError::Ffmpeg
        } else {
            PreparationError::Io
        }
    })?;
    let deadline = tokio::time::sleep(Duration::from_secs(if image { 60 } else { 600 }));
    tokio::pin!(deadline);
    let mut monitor = tokio::time::interval(Duration::from_millis(250));
    let limit = if image { MAX_IMAGE } else { MAX_VIDEO };
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|_| PreparationError::Io),
            _ = &mut *cancelled => { child.kill().await.ok(); return Err(PreparationError::Cancelled); },
            _ = &mut deadline => { child.kill().await.ok(); return Err(if image { PreparationError::Image } else { PreparationError::Video }); },
            _ = monitor.tick() => if output_size(&output, limit).is_err() { child.kill().await.ok(); return Err(PreparationError::Size); },
        }
    }?;
    if !status.success() {
        return Err(if image {
            PreparationError::Image
        } else {
            PreparationError::Video
        });
    }
    let size = output.metadata().map_err(|_| PreparationError::Io)?.len();
    if size == 0 || size > limit {
        return Err(PreparationError::Size);
    }
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(output))
        .await
        .map_err(|_| PreparationError::Io)?
        .map_err(|_| PreparationError::Io)?;
    if bytes.len() as u64 != size {
        return Err(PreparationError::Io);
    }
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    Ok((bytes, if image { "image/jpeg" } else { "video/mp4" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn preparation_source_stays_private_under_a_shared_temp_parent() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempfile::tempdir().unwrap();
        std::fs::set_permissions(parent.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let directory = private_tempdir_in(parent.path()).unwrap();
        let source = directory.path().join("source");
        std::fs::write(&source, b"private original media").unwrap();
        let mode = directory.path().metadata().unwrap().permissions().mode();
        assert_eq!(
            mode & 0o077,
            0,
            "other users must not traverse the directory"
        );
        assert_ne!(mode & 0o700, 0, "the owner must retain access");
        assert!(source.exists());
    }
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

    #[tokio::test]
    async fn converts_legacy_mov_with_leading_free_box() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.mov");
        let generated = std::process::Command::new(crate::host_command::resolve_program(
            "ffmpeg",
            &crate::host_command::effective_path(),
        ))
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
            "-c:v",
            "mpeg4",
        ])
        .arg(&input)
        .status();
        match generated {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            other => assert!(other.unwrap().success()),
        }
        let mut bytes = std::fs::read(input).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        bytes[4..8].copy_from_slice(b"free");
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "video:mov", &mut cancelled).await.unwrap();
        assert_eq!(mime, "video/mp4");
        assert!(prepared.windows(4).any(|chunk| chunk == b"ftyp"));
    }

    #[test]
    fn native_container_rules_match_the_webview_recognizers() {
        fn box_bytes(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut result = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
            result.extend_from_slice(kind);
            result.extend_from_slice(payload);
            result
        }
        for prefix in [b"free", b"wide", b"skip"] {
            let mut input = box_bytes(prefix, &[]);
            input.extend(box_bytes(b"ftyp", b"qt  \0\0\0\0"));
            assert_eq!(
                allowed_mode("video:mov", &input),
                Some(("mov", false, false))
            );
        }
        for box_kind in [b"moov", b"mdat"] {
            assert_eq!(
                allowed_mode("video:mov", &box_bytes(box_kind, &[0; 4])),
                Some(("mov", false, false))
            );
        }
        for brand in [b"M4VH", b"M4VP", b"NDSS", b"NSDC"] {
            assert_eq!(
                allowed_mode("video:mov", &box_bytes(b"ftyp", brand)),
                Some(("mov", false, false))
            );
        }
        assert_eq!(
            allowed_mode("voice:mp3", b"\xff\xfb\x90\x64"),
            Some(("mp3", false, true))
        );
        assert!(allowed_mode("voice:aac", b"\xff\xfb\x90\x64").is_none());
        assert!(allowed_mode("video:mov", &box_bytes(b"ftyp", b"avif")).is_none());
        assert!(allowed_mode("image:mov", &box_bytes(b"ftyp", b"zzzz")).is_none());
        assert_eq!(PreparationError::Io.code(), "io");
        assert_eq!(PreparationError::Image.status(), 400);
        assert_eq!(PreparationError::Cancelled.code(), "cancelled");
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
