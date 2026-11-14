//! Cockpit Remote's push (decision 46): the Mac sends Web Push straight to the phone's push
//! service (Apple's for a Home Screen web app on iOS 16.4+), signed with this Mac's own VAPID key
//! (RFC 8292) and encrypted to the phone's subscription keys (RFC 8291). No APNs key, no server of
//! ours: the push service sees only the ciphertext and the endpoint.

use base64ct::{Base64UrlUnpadded, Encoding as _};
use serde::{Deserialize, Serialize};
use web_push_native::jwt_simple::algorithms::{ECDSAP256KeyPairLike, ES256KeyPair};
use web_push_native::{p256::PublicKey, Auth, WebPushBuilder};

/// What `PushSubscription.toJSON()` gives the phone, sent to the Mac over the link.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: Keys,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Keys {
    pub p256dh: String,
    pub auth: String,
}

/// This Mac's VAPID key. The phone subscribes with its public half, so only this Mac can push.
pub struct Vapid(ES256KeyPair);

impl Vapid {
    pub fn generate() -> Self {
        Self(ES256KeyPair::generate())
    }

    pub fn from_private(b64: &str) -> Result<Self, String> {
        let raw = Base64UrlUnpadded::decode_vec(b64.trim()).map_err(|e| e.to_string())?;
        ES256KeyPair::from_bytes(&raw).map(Self).map_err(|e| e.to_string())
    }

    /// The private key to keep (Keychain), base64url.
    pub fn private(&self) -> String {
        Base64UrlUnpadded::encode_string(&self.0.to_bytes())
    }

    /// The `applicationServerKey` the phone subscribes with: the uncompressed P-256 point, base64url.
    pub fn public(&self) -> String {
        Base64UrlUnpadded::encode_string(&self.0.key_pair().public_key().to_bytes_uncompressed())
    }

    /// The HTTP request for one push: encrypted body, VAPID authorization, TTL and urgency.
    pub fn request(&self, sub: &Subscription, payload: &[u8], contact: &str) -> Result<http::Request<Vec<u8>>, String> {
        let ua = PublicKey::from_sec1_bytes(&Base64UrlUnpadded::decode_vec(&sub.keys.p256dh).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let auth_raw = Base64UrlUnpadded::decode_vec(&sub.keys.auth).map_err(|e| e.to_string())?;
        if auth_raw.len() != 16 {
            return Err("auth secret must be 16 bytes".into());
        }
        let builder = WebPushBuilder::new(sub.endpoint.parse().map_err(|e| format!("bad endpoint: {e}"))?, ua, Auth::clone_from_slice(&auth_raw)).with_vapid(&self.0, contact);
        let mut req = builder.build(payload.to_vec()).map_err(|e| e.to_string())?;
        req.headers_mut().insert("urgency", "high".parse().unwrap());
        Ok(req)
    }

    /// Sends one push; returns the push service's HTTP status (201 = accepted, 404/410 = the
    /// subscription is gone and the phone must subscribe again).
    pub fn send(&self, sub: &Subscription, payload: &[u8], contact: &str) -> Result<u16, String> {
        let req = self.request(sub, payload, contact)?;
        let mut call = ureq::post(req.uri().to_string());
        for (k, v) in req.headers() {
            call = call.header(k.as_str(), v.to_str().unwrap_or_default());
        }
        match call.config().http_status_as_error(false).build().send(req.body().as_slice()) {
            Ok(r) => Ok(r.status().as_u16()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_push_native::p256::{elliptic_curve::sec1::ToEncodedPoint, SecretKey};

    /// A phone's subscription keys, as a browser would make them.
    fn phone() -> (SecretKey, Subscription) {
        let sk = SecretKey::random(&mut web_push_native::p256::elliptic_curve::rand_core::OsRng);
        let p256dh = Base64UrlUnpadded::encode_string(sk.public_key().to_encoded_point(false).as_bytes());
        let sub = Subscription { endpoint: "https://web.push.apple.com/QGuQyavXutnMH".into(), keys: Keys { p256dh, auth: Base64UrlUnpadded::encode_string(&[7u8; 16]) } };
        (sk, sub)
    }

    #[test]
    fn only_the_phone_can_read_a_push() {
        let mac = Vapid::generate();
        let (sk, sub) = phone();
        let req = mac.request(&sub, br#"{"session":"s1","kind":"permission"}"#, "mailto:remote@cockpit.invalid").unwrap();
        assert_eq!(req.uri().to_string(), sub.endpoint);
        assert_eq!(req.headers()["content-encoding"], "aes128gcm");
        assert!(req.headers()["authorization"].to_str().unwrap().starts_with("vapid t="), "{:?}", req.headers()["authorization"]);
        assert!(req.headers()["authorization"].to_str().unwrap().contains(&mac.public()));
        assert!(!String::from_utf8_lossy(req.body()).contains("permission"), "the push service sees ciphertext only");
        let auth = Auth::clone_from_slice(&[7u8; 16]);
        let plain = web_push_native::decrypt(req.body().clone(), &sk, &auth).unwrap();
        assert_eq!(plain, br#"{"session":"s1","kind":"permission"}"#);
        // Another phone's keys can't open it.
        let (other, _) = phone();
        assert!(web_push_native::decrypt(req.body().clone(), &other, &auth).is_err());
    }

    #[test]
    fn the_vapid_key_survives_a_restart() {
        let a = Vapid::generate();
        let b = Vapid::from_private(&a.private()).unwrap();
        assert_eq!(a.public(), b.public());
        assert_eq!(Base64UrlUnpadded::decode_vec(&a.public()).unwrap().len(), 65, "uncompressed P-256 point");
    }
}
