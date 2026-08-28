//! Touch ID unlock — capability probe.
//!
//! Unlocking with a fingerprint means the app password (which derives the DB
//! encryption key) has to live somewhere the fingerprint can release. The only
//! place on macOS that actually enforces that is a Keychain item guarded by a
//! `SecAccessControl` with a biometry constraint: the Secure Enclave releases it
//! after a successful Touch ID and nothing else can read it.
//!
//! That storage requires the *data protection* keychain, which requires
//! entitlements, which require a Developer ID signature. Yfine ships unsigned
//! (ad-hoc), so `SecItemAdd` answers `errSecMissingEntitlement` (-34018).
//!
//! The alternative — parking the password in the ordinary login keychain and
//! gating it on an app-side `LAContext` check — is deliberately NOT implemented:
//! it would move the password out of the user's head and into a store any
//! process running as them can ask for, weakening the at-rest encryption this
//! app exists to provide, and an ad-hoc signature changes on every build, so its
//! keychain ACL would break (and re-prompt for the login password) after every
//! update anyway.
//!
//! So this module reports, precisely, whether the real thing is possible. The
//! moment the bundle is signed with a Developer ID and the keychain entitlement,
//! `probe` starts returning `Available` and the unlock flow can be built on it.

use serde::Serialize;

#[derive(Serialize)]
pub struct BiometricStatus {
    /// True only when the OS would actually enforce the fingerprint.
    pub available: bool,
    /// Machine-readable reason: "ok" | "unsupported_platform" | "needs_signing" | "no_biometry" | "error".
    pub reason: String,
    /// Raw OSStatus when the probe failed, for the settings screen / bug reports.
    pub code: Option<i32>,
}

#[cfg(target_os = "macos")]
fn probe_macos() -> BiometricStatus {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{delete_generic_password, set_generic_password_options};
    use security_framework::passwords_options::{AccessControlOptions, PasswordOptions};

    // A throwaway item under its own service name: writing it never prompts
    // (only reading a biometry-guarded item does), so the probe is silent.
    const SERVICE: &str = "com.yfine.desktop.biometric-probe";
    const ACCOUNT: &str = "probe";
    let _ = delete_generic_password(SERVICE, ACCOUNT);

    let access = match SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
        AccessControlOptions::BIOMETRY_CURRENT_SET.bits(),
    ) {
        Ok(a) => a,
        Err(e) => {
            // The device has no biometry enrolled (or none at all): the flags are
            // rejected before any keychain call happens.
            return BiometricStatus {
                available: false,
                reason: "no_biometry".into(),
                code: Some(e.code()),
            };
        }
    };

    let mut opts = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
    opts.set_access_control(access);
    match set_generic_password_options(b"probe", opts) {
        Ok(()) => {
            let _ = delete_generic_password(SERVICE, ACCOUNT);
            BiometricStatus { available: true, reason: "ok".into(), code: None }
        }
        Err(e) => {
            // -34018 errSecMissingEntitlement: unsigned / no keychain entitlement.
            let reason = if e.code() == -34018 { "needs_signing" } else { "error" };
            BiometricStatus { available: false, reason: reason.into(), code: Some(e.code()) }
        }
    }
}

#[tauri::command]
pub fn biometric_status() -> BiometricStatus {
    #[cfg(target_os = "macos")]
    {
        probe_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        BiometricStatus { available: false, reason: "unsupported_platform".into(), code: None }
    }
}
