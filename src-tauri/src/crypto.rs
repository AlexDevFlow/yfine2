//! At-rest DB encryption — byte-compatible with the legacy Yfine `yfine.db.enc`
//! format so an existing encrypted database migrates unchanged.
//!
//! Layout (new):  b"YF256\x01" (6) + nonce (12) + AES-256-GCM ciphertext(+tag).
//! Key:           PBKDF2-HMAC-SHA256, 32 bytes, 480_000 iters over the UTF-8
//!                password with the stored `encryption_salt`.
//! Legacy read:   archives without the magic header are Fernet tokens whose key
//!                is urlsafe-base64 of the same derived 32-byte key.
//! Password hash: PBKDF2-HMAC-SHA256, 32-byte hash + 32-byte salt, same iters.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use sha2::Sha256;

const MAGIC: &[u8] = b"YF256\x01";
const ITERATIONS: u32 = 480_000;

pub fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, ITERATIONS, &mut key);
    key
}

pub fn random_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// (hash_hex, salt_hex)
pub fn hash_password(password: &str) -> (String, String) {
    let mut salt = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive_key(password, &salt);
    (hex::encode(key), hex::encode(salt))
}

pub fn verify_password(password: &str, hash_hex: &str, salt_hex: &str) -> bool {
    let salt = match hex::decode(salt_hex) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let computed = hex::encode(derive_key(password, &salt));
    // length-independent equality (inputs are fixed-length hex here)
    computed.len() == hash_hex.len()
        && computed
            .bytes()
            .zip(hash_hex.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

pub fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher.encrypt(nonce, plaintext).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(MAGIC.len() + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(archive: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if archive.starts_with(MAGIC) {
        if archive.len() < MAGIC.len() + 12 {
            return Err("truncated archive".into());
        }
        let nonce = Nonce::from_slice(&archive[MAGIC.len()..MAGIC.len() + 12]);
        let ct = &archive[MAGIC.len() + 12..];
        let cipher = Aes256Gcm::new(key.into());
        cipher.decrypt(nonce, ct).map_err(|e| e.to_string())
    } else {
        // legacy Fernet: key = urlsafe-b64 of the derived 32-byte key
        let fkey = base64::engine::general_purpose::URL_SAFE.encode(key);
        let f = fernet::Fernet::new(&fkey).ok_or_else(|| "invalid fernet key".to_string())?;
        let token = std::str::from_utf8(archive).map_err(|e| e.to_string())?;
        f.decrypt(token.trim()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes256_round_trip() {
        let key = derive_key("hunter2", b"some-salt-bytes");
        let plain = b"the quick brown fox jumps over the lazy dog";
        let archive = encrypt(plain, &key).unwrap();
        // On-disk format: magic + 12-byte nonce + ciphertext(+16-byte GCM tag).
        assert!(archive.starts_with(MAGIC));
        assert_eq!(&archive[..MAGIC.len()], b"YF256\x01");
        assert_eq!(archive.len(), MAGIC.len() + 12 + plain.len() + 16);
        assert_eq!(decrypt(&archive, &key).unwrap(), plain);
    }

    #[test]
    fn nonce_is_fresh_per_encryption() {
        let key = derive_key("pw", b"salt");
        let a = encrypt(b"same plaintext", &key).unwrap();
        let b = encrypt(b"same plaintext", &key).unwrap();
        // Identical plaintext must yield distinct archives (random nonce).
        assert_ne!(a, b);
        // Both still decrypt to the same plaintext.
        assert_eq!(decrypt(&a, &key).unwrap(), decrypt(&b, &key).unwrap());
    }

    #[test]
    fn decrypt_wrong_key_fails_not_panics() {
        let archive = encrypt(b"secret", &derive_key("right", b"salt")).unwrap();
        assert!(decrypt(&archive, &derive_key("wrong", b"salt")).is_err());
    }

    #[test]
    fn decrypt_rejects_truncated_archive() {
        let mut archive = encrypt(b"x", &derive_key("pw", b"salt")).unwrap();
        archive.truncate(MAGIC.len() + 4); // shorter than magic + nonce
        assert!(decrypt(&archive, &derive_key("pw", b"salt")).is_err());
    }

    #[test]
    fn password_hash_verify() {
        let (h, s) = hash_password("correct horse battery staple");
        assert_eq!(h.len(), 64); // 32 bytes hex
        assert_eq!(s.len(), 64);
        assert!(verify_password("correct horse battery staple", &h, &s));
        assert!(!verify_password("wrong", &h, &s));
        // Tampered salt → false, never a panic.
        assert!(!verify_password("correct horse battery staple", &h, "zz"));
    }

    #[test]
    fn derive_key_deterministic_and_salt_sensitive() {
        assert_eq!(derive_key("pw", b"salt-a"), derive_key("pw", b"salt-a"));
        assert_ne!(derive_key("pw", b"salt-a"), derive_key("pw", b"salt-b"));
        assert_ne!(derive_key("pw-a", b"salt"), derive_key("pw-b", b"salt"));
    }

    #[test]
    fn random_hex_length_and_uniqueness() {
        let a = random_hex(32);
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_hex(32));
    }

    #[test]
    fn legacy_fernet_read_path() {
        // A Fernet archive (no YF256 magic) must still decrypt with the same
        // derived key urlsafe-b64-encoded — the migration read path.
        let key = derive_key("legacy-pw", b"legacy-salt");
        let fkey = base64::engine::general_purpose::URL_SAFE.encode(key);
        let f = fernet::Fernet::new(&fkey).unwrap();
        let token = f.encrypt(b"old archive contents");
        assert!(!token.as_bytes().starts_with(MAGIC));
        assert_eq!(
            decrypt(token.as_bytes(), &key).unwrap(),
            b"old archive contents"
        );
    }
}
