//! Owner-signed intent to configure one identity/community pair.
//! Local import and existing setups do not depend on this confirmation.
use crate::config::{canonical_key, canonical_relay};
use crate::Result;
use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommunityResolution {
    pub pubkey: String,
    pub relay_url: String,
    pub owner: String,
    pub signature: String,
}
impl CommunityResolution {
    pub fn verify(&self, auth: &str) -> Result<()> {
        crate::secret::validate_attestation(auth, &self.pubkey)?;
        let tag: Vec<String> = serde_json::from_str(auth).map_err(|_| "Invalid source owner")?;
        if !canonical_key(&self.pubkey)
            || tag[1] != self.owner
            || canonical_relay(&self.relay_url)? != self.relay_url
        {
            return Err(
                "Community resolution does not match the source owner or destination".into(),
            );
        }
        let owner: XOnlyPublicKey = self.owner.parse().map_err(|_| "Invalid resolution owner")?;
        let signature: Signature = self
            .signature
            .parse()
            .map_err(|_| "Invalid resolution signature")?;
        let digest = Sha256::digest(format!(
            "nostr:agent-community:{}:{}",
            self.pubkey, self.relay_url
        ));
        Secp256k1::verification_only()
            .verify_schnorr(&signature, &digest, &owner)
            .map_err(|_| "Community resolution was not signed by the source owner".into())
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use secp256k1::{Keypair, SecretKey};
    const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    pub(crate) fn resolution(relay: &str) -> CommunityResolution {
        let secp = Secp256k1::new();
        let mut bytes = [0; 32];
        bytes[31] = 2;
        let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
        CommunityResolution {
            pubkey: PUB.into(),
            relay_url: relay.into(),
            owner: pair.x_only_public_key().0.to_string(),
            signature: secp
                .sign_schnorr_no_aux_rand(
                    &Sha256::digest(format!("nostr:agent-community:{PUB}:{relay}")),
                    &pair,
                )
                .to_string(),
        }
    }
    #[test]
    fn owner_can_confirm_multiple_pairs_without_import_or_storage() {
        let auth = crate::secret::test_attestation(PUB);
        resolution("wss://one.example").verify(&auth).unwrap();
        resolution("wss://two.example").verify(&auth).unwrap();
    }
    #[test]
    fn unsigned_or_retargeted_resolution_is_rejected() {
        let auth = crate::secret::test_attestation(PUB);
        for change in ["destination", "identity", "owner", "signature"] {
            let mut value = resolution("wss://one.example");
            match change {
                "destination" => value.relay_url = "wss://two.example".into(),
                "identity" => value.pubkey = "ab".repeat(32),
                "owner" => value.owner = "cd".repeat(32),
                _ => value.signature = "00".repeat(64),
            }
            assert!(value.verify(&auth).is_err());
        }
    }
}
