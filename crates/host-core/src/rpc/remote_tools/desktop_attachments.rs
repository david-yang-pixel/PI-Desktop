//! Route a Read of an explicitly submitted desktop attachment to the local
//! runner before dispatch. Remote files and every other tool stay on the Host.
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{scratch, transcripts, workspace};

// The same maximum as the desktop composer file import.
const MAX_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;

pub(in crate::rpc) fn desktop_attachment_root(
    data_dir: &Path,
    session_id: &str,
    tool_name: &str,
    args: &Value,
) -> anyhow::Result<Option<PathBuf>> {
    if tool_name != "Read" {
        return Ok(None);
    }
    let Some(path) = args.get("path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(scratch) = scratch::session_dir(data_dir, session_id) else {
        return Ok(None);
    };
    let input = Path::new(path);
    if !input.is_absolute() {
        return Ok(None);
    }
    let canonical_data = workspace::simple_canonicalize(data_dir)?;
    let Some(root) = scratch::session_dir(&canonical_data, session_id) else {
        return Ok(None);
    };
    let Ok(relative) = input
        .strip_prefix(&scratch)
        .or_else(|_| input.strip_prefix(&root))
    else {
        return Ok(None);
    };
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Ok(None);
    }
    let candidate = root.join(relative);
    if !workspace::simple_canonicalize(&candidate).is_ok_and(|actual| actual == candidate) {
        return Ok(None);
    }
    let Ok(metadata) = candidate.metadata() else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_BYTES {
        return Ok(None);
    }

    let records = transcripts::read_transcript(data_dir, session_id)?;
    // Inline file chips (including automatic long-text pastes) are stored as
    // @path text rather than attachment blocks. Honor only the exact reference
    // in a sent user message and only inside the owning session's paste folder.
    if relative.starts_with("pasted") {
        let marker = if path.chars().any(char::is_whitespace) {
            format!("@\"{path}\"")
        } else {
            format!("@{path}")
        };
        let sent = records
            .iter()
            .filter(|message| message.role == "user")
            .filter_map(|message| message.blocks.as_array())
            .flatten()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .any(|text| {
                text.match_indices(&marker).any(|(start, _)| {
                    text[start + marker.len()..]
                        .chars()
                        .next()
                        .is_none_or(char::is_whitespace)
                })
            });
        if sent {
            return Ok(Some(scratch));
        }
    }
    let mut stored_hashes = Vec::new();
    for block in records
        .iter()
        .filter(|message| message.role == "user")
        .filter_map(|message| message.blocks.as_array())
        .flatten()
    {
        if block["type"] != "attachment"
            || !matches!(block["kind"].as_str(), Some("file" | "image"))
        {
            continue;
        }
        let Some(reference) = block["ref"].as_str() else {
            continue;
        };
        if Path::new(reference) == input || Path::new(reference) == candidate {
            return Ok(Some(scratch));
        }
        // Images and replayed blobs have a content-addressed ref in history
        // instead of the scratch path used by Read. Match the submitted bytes.
        if let Some(hash) = reference.strip_prefix("attachments/") {
            if hash.len() == 64 && block["size"].as_u64() == Some(metadata.len()) {
                stored_hashes.push(hash);
            }
        }
    }
    if stored_hashes.is_empty() {
        return Ok(None);
    }
    let mut file = std::fs::File::open(&candidate)?.take(metadata.len() + 1);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 8192];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        digest.update(&buffer[..count]);
    }
    let hash = hex::encode(digest.finalize());
    Ok((size == metadata.len() && stored_hashes.contains(&hash.as_str())).then_some(scratch))
}
