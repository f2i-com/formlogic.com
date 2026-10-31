//! Opening FormLogic's sealed backups (`FLBK1`, `Support/BackupEnvelope.php` and
//! `docs/DATA_ENCRYPTION.md` in FormLogic).
//!
//! ```text
//! "FLBK1\n" | uint32 BE header length | header JSON | chunks
//! chunk = uint32 BE length | XChaCha20-Poly1305 of up to 4 MiB
//! nonce = 16 random bytes from the header | uint64 BE chunk index
//! associated data = "flbk:1|<id>|<index>|<count>"
//! ```
//!
//! The file key is sealed to this computer's backup key with `crypto_box_seal`. A chunk can't be
//! moved, dropped or added, and bytes after the last chunk are refused. Nothing here writes a
//! file: [`open`] writes to a writer, and the caller decides what happens if it fails half way.

use std::io::{Read, Write};
use std::path::Path;

use base64::Engine as _;
use oaiy_crypto::x25519::SecretKey;
use oaiy_crypto::zeroize::Secret;
use oaiy_crypto::{aead, sealbox};
use serde_json::Value;

const MAGIC: &[u8] = b"FLBK1\n";
const CIPHER: &str = "xchacha20p1305-chunked.1";
const CHUNK_BYTES: usize = 4_194_304;
const MAX_HEADER_BYTES: usize = 65_536;

const DAMAGED: &str = "This backup is damaged.";
const NOT_YOURS: &str = "This backup was sealed to another key: enter the twelve words it was made with.";

/// What a sealed file says about itself. None of it is trusted until the chunks have opened.
pub struct Header {
    id: String,
    chunk_count: u64,
    base_nonce: [u8; 16],
    sealed_keys: Vec<Vec<u8>>,
}

fn read_exact<R: Read>(reader: &mut R, bytes: usize) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0u8; bytes];
    reader.read_exact(&mut buffer).map_err(|_| DAMAGED.to_string())?;
    Ok(buffer)
}

fn read_length<R: Read>(reader: &mut R) -> Result<usize, String> {
    let bytes: [u8; 4] = read_exact(reader, 4)?.try_into().map_err(|_| DAMAGED.to_string())?;
    Ok(u32::from_be_bytes(bytes) as usize)
}

/// Reads as far as the first chunk.
pub fn read_header<R: Read>(reader: &mut R) -> Result<Header, String> {
    if read_exact(reader, MAGIC.len()).map_err(|_| "This is not a sealed backup.".to_string())? != MAGIC {
        return Err("This is not a sealed backup.".to_string());
    }
    let length = read_length(reader)?;
    if length == 0 || length > MAX_HEADER_BYTES {
        return Err(DAMAGED.to_string());
    }
    let header: Value = serde_json::from_slice(&read_exact(reader, length)?).map_err(|_| DAMAGED.to_string())?;
    let base64 = base64::engine::general_purpose::STANDARD;
    let base_nonce = header.get("baseNonce").and_then(Value::as_str).and_then(|n| base64.decode(n).ok()).and_then(|n| <[u8; 16]>::try_from(n.as_slice()).ok());
    let (Some(1), Some(CIPHER), Some(id), Some(chunk_count), Some(base_nonce), Some(recipients)) = (
        header.get("v").and_then(Value::as_u64),
        header.get("cipher").and_then(Value::as_str),
        header.get("id").and_then(Value::as_str),
        header.get("chunkCount").and_then(Value::as_u64).filter(|count| *count >= 1),
        base_nonce,
        header.get("recipients").and_then(Value::as_array),
    ) else {
        return Err(DAMAGED.to_string());
    };
    let sealed_keys = recipients
        .iter()
        .filter(|recipient| recipient.get("kind").and_then(Value::as_str) == Some("publicKey"))
        .filter_map(|recipient| recipient.get("sealedKey").and_then(Value::as_str))
        .filter_map(|sealed| base64.decode(sealed).ok())
        .collect();
    Ok(Header { id: id.to_string(), chunk_count, base_nonce, sealed_keys })
}

fn file_key(header: &Header, key: &SecretKey) -> Result<Secret<32>, String> {
    for sealed in &header.sealed_keys {
        if let Ok(opened) = sealbox::open(key, sealed) {
            return Secret::from_slice(opened.expose()).map_err(|_| DAMAGED.to_string());
        }
    }
    Err(NOT_YOURS.to_string())
}

/// Whether `key` opens this file. Reads only its header.
pub fn opens(path: &Path, key: &SecretKey) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return false };
    read_header(&mut std::io::BufReader::new(file)).and_then(|header| file_key(&header, key).map(|_| ())).is_ok()
}

/// A small file sealed to `key`, for other modules' tests.
#[cfg(test)]
pub fn sealed_for_tests(key: &SecretKey) -> Vec<u8> {
    tests::seal(&[b"sealed"], &key.public_key())
}

/// Decrypts a sealed file into `out`. A failure can come after some of it was written: every chunk
/// has been checked only when this returns `Ok`.
pub fn open<R: Read, W: Write>(reader: &mut R, out: &mut W, key: &SecretKey) -> Result<(), String> {
    let header = read_header(reader)?;
    let file_key = file_key(&header, key)?;
    for index in 0..header.chunk_count {
        let length = read_length(reader)?;
        if length == 0 || length > CHUNK_BYTES + aead::TAG_LEN {
            return Err(DAMAGED.to_string());
        }
        let sealed = read_exact(reader, length)?;
        let mut nonce = [0u8; aead::NONCE_LEN];
        nonce[..16].copy_from_slice(&header.base_nonce);
        nonce[16..].copy_from_slice(&index.to_be_bytes());
        let data = format!("flbk:1|{}|{index}|{}", header.id, header.chunk_count);
        let plain = aead::open(&file_key, &nonce, data.as_bytes(), &sealed).map_err(|_| DAMAGED.to_string())?;
        out.write_all(plain.expose()).map_err(|e| format!("Could not write the backup: {e}"))?;
    }
    let mut trailing = [0u8; 1];
    match reader.read(&mut trailing) {
        Ok(0) => Ok(()),
        _ => Err(DAMAGED.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    use oaiy_crypto::x25519::PublicKey;

    /// Made by FormLogic's `BackupEnvelope::seal`, in PHP with libsodium, to the key below: this is
    /// what proves the two ends agree. The plain text is "made by formlogic", 64 times.
    const SECRET: &str = include_str!("fixtures/flbk-secret.txt");
    const SEALED: &str = include_str!("fixtures/flbk-sealed.txt");
    const PLAIN_SHA256: &str = include_str!("fixtures/flbk-plain-sha256.txt");

    fn fixture() -> (Vec<u8>, SecretKey) {
        let base64 = base64::engine::general_purpose::STANDARD;
        let sealed = base64.decode(SEALED.split_whitespace().collect::<String>()).unwrap();
        let secret = base64.decode(SECRET.trim()).unwrap();
        (sealed, SecretKey::from_slice(&secret).unwrap())
    }

    fn opened(sealed: &[u8], key: &SecretKey) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        open(&mut Cursor::new(sealed), &mut out, key)?;
        Ok(out)
    }

    /// Seals as FormLogic does, for the cases a fixture can't be damaged into.
    pub(super) fn seal(plain_chunks: &[&[u8]], to: &PublicKey) -> Vec<u8> {
        let base64 = base64::engine::general_purpose::STANDARD;
        let key = Secret::<32>::random().unwrap();
        let base_nonce = [9u8; 16];
        let count = plain_chunks.len();
        let header = serde_json::json!({
            "v": 1, "id": "ab", "cipher": CIPHER, "chunkCount": count, "baseNonce": base64.encode(base_nonce),
            "recipients": [{"kind": "publicKey", "sealedKey": base64.encode(sealbox::seal(to, key.expose()).unwrap())}],
        })
        .to_string();
        let mut file = MAGIC.to_vec();
        file.extend_from_slice(&(header.len() as u32).to_be_bytes());
        file.extend_from_slice(header.as_bytes());
        for (index, chunk) in plain_chunks.iter().enumerate() {
            let sealed = keyed_chunk(&key, &base_nonce, index as u64, count, chunk);
            file.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
            file.extend_from_slice(&sealed);
        }
        file
    }

    /// One chunk, under the nonce the format gives it: a nonce the caller chooses is for tests only.
    fn keyed_chunk(key: &Secret<32>, base: &[u8; 16], index: u64, count: usize, plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; aead::NONCE_LEN];
        nonce[..16].copy_from_slice(base);
        nonce[16..].copy_from_slice(&index.to_be_bytes());
        aead::seal(key, aead::Nonce::from_bytes_for_tests(nonce), format!("flbk:1|ab|{index}|{count}").as_bytes(), plain).unwrap()
    }

    #[test]
    fn a_file_formlogic_sealed_opens_here() {
        let (sealed, key) = fixture();
        let plain = opened(&sealed, &key).unwrap();
        assert_eq!(oaiy_crypto::kdf::sha256_hex(&plain), PLAIN_SHA256.trim());
    }

    #[test]
    fn another_key_opens_nothing() {
        let (sealed, _) = fixture();
        assert_eq!(opened(&sealed, &SecretKey::generate().unwrap()).unwrap_err(), NOT_YOURS);
    }

    #[test]
    fn a_changed_byte_is_refused() {
        let (mut sealed, key) = fixture();
        let at = sealed.len() - 40;
        sealed[at] ^= 1;
        assert_eq!(opened(&sealed, &key).unwrap_err(), DAMAGED);
    }

    #[test]
    fn a_file_cut_short_is_refused() {
        let (sealed, key) = fixture();
        assert_eq!(opened(&sealed[..sealed.len() - 10], &key).unwrap_err(), DAMAGED);
    }

    #[test]
    fn bytes_after_the_last_chunk_are_refused() {
        let (mut sealed, key) = fixture();
        sealed.push(0);
        assert_eq!(opened(&sealed, &key).unwrap_err(), DAMAGED);
    }

    #[test]
    fn chunks_in_another_order_are_refused() {
        let key = SecretKey::generate().unwrap();
        let file = seal(&[b"first", b"second"], &key.public_key());
        assert_eq!(opened(&file, &key).unwrap(), b"firstsecond");

        // Swap the two chunks, each a length of 4 and the text and a 16-byte tag.
        let tail = file.len() - (4 + 5 + 16) - (4 + 6 + 16);
        let (head, chunks) = file.split_at(tail);
        let (first, second) = chunks.split_at(4 + 5 + 16);
        let swapped = [head, second, first].concat();
        assert_eq!(opened(&swapped, &key).unwrap_err(), DAMAGED);
    }

    #[test]
    fn a_header_says_whether_a_key_opens_a_file() {
        let dir = std::env::temp_dir().join(format!("fl-backups-opens-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sealed.flbk");
        let key = SecretKey::generate().unwrap();
        std::fs::write(&path, seal(&[b"x"], &key.public_key())).unwrap();

        assert!(opens(&path, &key));
        assert!(!opens(&path, &SecretKey::generate().unwrap()));
        assert!(!opens(&dir.join("missing"), &key));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_that_is_no_backup_says_so() {
        let key = SecretKey::generate().unwrap();
        assert_eq!(opened(b"PK\x03\x04 a zip", &key).unwrap_err(), "This is not a sealed backup.");
        assert_eq!(opened(b"", &key).unwrap_err(), "This is not a sealed backup.");
    }

    #[test]
    fn an_impossibly_long_chunk_is_refused_before_it_is_read() {
        let key = SecretKey::generate().unwrap();
        let file = seal(&[b"x"], &key.public_key());
        let tail = file.len() - (4 + 1 + 16);
        let mut damaged = file[..tail].to_vec();
        damaged.extend_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(opened(&damaged, &key).unwrap_err(), DAMAGED);
    }
}
