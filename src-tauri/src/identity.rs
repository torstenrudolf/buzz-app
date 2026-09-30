//! One create-only human identity. Never consult legacy, agent, file or environment keys.
use bech32::{primitives::decode::CheckedHrpstring, Bech32, Hrp};
use secp256k1::{Keypair, PublicKey, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
const INVALID: &str = "Enter a valid nsec private key";
const MALFORMED: &str = "Saved identity is malformed; nothing was changed. Keep your key backup and contact support before changing secure storage.";
// Debug identities must never occupy the create-only release item.
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux", test))]
const SERVICE: &str = if cfg!(debug_assertions) {
    "dev.local.buzz.foundation.identity.debug"
} else {
    "dev.local.buzz.foundation.identity"
};

// No Debug/Serialize: only deliberate export may return the secret to the main UI.
struct Key(Zeroizing<[u8; 32]>);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EventTemplate {
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

impl Key {
    fn sign(&self, event: EventTemplate) -> Result<serde_json::Value> {
        let pubkey = self.viewer()?;
        let serialized = serde_json::to_vec(&serde_json::json!([
            0,
            pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]))
        .map_err(|_| "Could not encode relay event")?;
        if serialized.len() > 64 * 1024 {
            return Err("Relay event is too large".into());
        }
        let hash = Sha256::digest(serialized);
        let secp = Secp256k1::signing_only();
        let mut secret = SecretKey::from_byte_array(*self.0).map_err(|_| INVALID)?;
        let mut pair = Keypair::from_secret_key(&secp, &secret);
        secret.non_secure_erase();
        let mut random = Zeroizing::new([0; 32]);
        if getrandom::fill(random.as_mut()).is_err() {
            pair.non_secure_erase();
            return Err("Could not sign relay event".into());
        }
        let signature = secp.sign_schnorr_with_aux_rand(&hash, &pair, &random);
        pair.non_secure_erase();
        Ok(serde_json::json!({
            "id": format!("{hash:x}"), "pubkey": pubkey,
            "created_at": event.created_at, "kind": event.kind,
            "tags": event.tags, "content": event.content, "sig": signature.to_string()
        }))
    }
    fn parse(text: &str) -> Result<Self> {
        let text = text.trim();
        if text.len() != 63 || !(text.starts_with("nsec1") || text.starts_with("NSEC1")) {
            return Err(INVALID.into());
        }
        let checked = CheckedHrpstring::new::<Bech32>(text).map_err(|_| INVALID)?;
        let mut bytes = Zeroizing::new([0; 32]);
        let mut values = checked.byte_iter();
        for byte in bytes.iter_mut() {
            *byte = values.next().ok_or(INVALID)?;
        }
        if values.next().is_some() {
            return Err(INVALID.into());
        }
        let key = Self(bytes);
        key.viewer()?;
        Ok(key)
    }
    fn generate() -> Result<Self> {
        loop {
            let mut bytes = Zeroizing::new([0; 32]);
            getrandom::fill(bytes.as_mut()).map_err(|_| "Could not create an identity")?;
            let key = Self(bytes);
            if key.viewer().is_ok() {
                return Ok(key);
            }
        }
    }
    fn viewer(&self) -> Result<String> {
        let mut key = SecretKey::from_byte_array(*self.0).map_err(|_| INVALID)?;
        let public = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
            .x_only_public_key()
            .0
            .to_string();
        key.non_secure_erase();
        Ok(public)
    }
    fn nsec(&self) -> Result<String> {
        bech32::encode::<Bech32>(Hrp::parse("nsec").map_err(|_| INVALID)?, self.0.as_ref())
            .map_err(|_| "Could not encode your private key".into())
    }
}

trait Store: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn add(&self, value: &[u8]) -> Result<()>;
}
struct OsStore;
#[cfg(all(target_os = "macos", not(test)))]
mod platform {
    use super::*;
    use security_framework::os::macos::keychain::SecKeychain;
    const ACCOUNT: &str = "human";
    fn error(error: security_framework::base::Error) -> String {
        match error.code() {
            -25299 => {
                "An identity is already saved; nothing was overwritten. Restart to restore it."
            }
            -128 | -25293 | -25308 => {
                "Keychain access was denied. Allow access and retry; no identity was created."
            }
            _ => "Your identity could not be accessed in Keychain. Retry without changing keys.",
        }
        .into()
    }
    impl Store for OsStore {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            let keychain = SecKeychain::default().map_err(error)?;
            match keychain.find_generic_password(SERVICE, ACCOUNT) {
                Ok((password, _)) => Ok(Some(Zeroizing::new(password.to_vec()))),
                Err(e) if e.code() == -25300 => Ok(None),
                Err(e) => Err(error(e)),
            }
        }
        fn add(&self, value: &[u8]) -> Result<()> {
            SecKeychain::default()
                .map_err(error)?
                .add_generic_password(SERVICE, ACCOUNT, value)
                .map_err(error)
        }
    }
}
#[cfg(all(any(target_os = "windows", target_os = "linux"), not(test)))]
mod keyring_platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    const ACCOUNT: &str = "human";
    fn error(error: Error) -> String {
        match error {
            Error::Occupied => "An identity is already saved; nothing was overwritten. Restart to restore it.",
            Error::Denied => "Secure storage access was denied. Allow access and retry; no identity was created.",
            Error::Busy => "Another Buzz app is accessing secure storage. Retry shortly.",
            Error::Corrupt => MALFORMED,
            _ => "Your identity could not be accessed in secure storage. Unlock your credential store and retry without changing keys.",
        }.into()
    }
    impl Store for OsStore {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            match credentials::read(SERVICE, ACCOUNT) {
                Ok(value) => Ok(Some(value)),
                Err(Error::Absent) => Ok(None),
                Err(e) => Err(error(e)),
            }
        }
        fn add(&self, value: &[u8]) -> Result<()> {
            credentials::add(SERVICE, ACCOUNT, value).map_err(error)
        }
    }
}
// Native tests cannot touch an OS credential store, even via the default host.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl Store for OsStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
    fn add(&self, _: &[u8]) -> Result<()> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
}

#[derive(Default)]
enum State {
    #[default]
    Unread,
    Missing,
    Ready(Key),
}
struct Identity {
    state: State,
    store: Box<dyn Store>,
}
impl Identity {
    fn restore(&mut self) -> Result<Option<String>> {
        if matches!(self.state, State::Unread) {
            self.state = match self.store.read()? {
                None => State::Missing,
                Some(bytes) => {
                    let text = std::str::from_utf8(&bytes).map_err(|_| MALFORMED)?;
                    State::Ready(Key::parse(text).map_err(|_| MALFORMED)?)
                }
            };
        }
        match &self.state {
            State::Ready(key) => key.viewer().map(Some),
            _ => Ok(None),
        }
    }
    fn save(&mut self, supplied: Option<&str>) -> Result<String> {
        if self.restore()?.is_some() {
            return Err("An identity is already saved; nothing was overwritten".into());
        }
        // Errors, denied reads and malformed stored keys never trigger generation.
        let key = match supplied {
            Some(text) => Key::parse(text)?,
            None => Key::generate()?,
        };
        let viewer = key.viewer()?;
        let nsec = Zeroizing::new(key.nsec()?);
        self.store.add(nsec.as_bytes())?;
        self.state = State::Ready(key); // Commit in memory only after secure persistence.
        Ok(viewer)
    }
    fn export(&mut self) -> Result<String> {
        self.restore()?;
        match &self.state {
            State::Ready(key) => key.nsec(),
            _ => Err("Set up your identity first".into()),
        }
    }
}

#[derive(Clone)]
pub struct IdentityHost(Arc<Mutex<Identity>>);
impl IdentityHost {
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self(Arc::new(Mutex::new(Identity {
            state: State::Ready(Key(Zeroizing::new([1; 32]))),
            store: Box::new(OsStore),
        })))
    }

    // Only host-owned purpose-bound operations may use this closure. Never expose the
    // secret, or a general decrypt/sign command, to the webview.
    pub(crate) async fn with_key<T: Send + 'static>(
        &self,
        action: impl FnOnce(&[u8; 32], &str) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            match &identity.state {
                State::Ready(key) => action(&key.0, &key.viewer()?),
                _ => Err("Set up your identity first".into()),
            }
        })
        .await
    }

    pub(crate) async fn sign(&self, event: EventTemplate) -> Result<serde_json::Value> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            match &identity.state {
                State::Ready(key) => key.sign(event),
                _ => Err("Set up your identity first".into()),
            }
        })
        .await
    }
}
impl Default for IdentityHost {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Identity {
            state: State::Unread,
            store: Box::new(OsStore),
        })))
    }
}
async fn with_identity<T: Send + 'static>(
    host: IdentityHost,
    action: impl FnOnce(&mut Identity) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut identity = host
            .0
            .lock()
            .map_err(|_| "Identity is unavailable; restart the app")?;
        action(&mut identity)
    })
    .await
    .map_err(|_| "Identity operation could not complete")?
}
#[tauri::command]
pub async fn identity_restore(host: tauri::State<'_, IdentityHost>) -> Result<Option<String>> {
    with_identity(host.inner().clone(), Identity::restore).await
}
#[tauri::command]
pub async fn identity_import(host: tauri::State<'_, IdentityHost>, nsec: String) -> Result<String> {
    let nsec = Zeroizing::new(nsec);
    with_identity(host.inner().clone(), move |identity| {
        identity.save(Some(&nsec))
    })
    .await
}
#[tauri::command]
pub async fn identity_create(host: tauri::State<'_, IdentityHost>) -> Result<String> {
    with_identity(host.inner().clone(), |identity| identity.save(None)).await
}
#[tauri::command]
pub async fn identity_export(host: tauri::State<'_, IdentityHost>) -> Result<String> {
    with_identity(host.inner().clone(), Identity::export).await
}

#[cfg(test)]
mod tests;
