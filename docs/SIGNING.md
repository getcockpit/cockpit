# Signing and notarisation

Why it matters: in synthetic-user testing, the unsigned app was the top reason people on company laptops wouldn't install Cockpit (approved-software lists, Gatekeeper and SmartScreen warnings). A signed, notarised build opens with no prompt.

The pipeline is already wired. `scripts/package.sh` and `.github/workflows/release.yml` sign with a Developer ID and notarise as soon as the secrets below exist. Without them, nothing changes: builds keep the ad-hoc signature.

## macOS (about 1 hour, plus Apple's review of the account)

1. Join the Apple Developer Program as an individual ($99 a year): developer.apple.com/programs.
2. In Xcode → Settings → Accounts → Manage Certificates, create a **Developer ID Application** certificate.
3. Export it from Keychain Access as a `.p12` with a password, then `base64 -i cert.p12 | pbcopy`.
4. Create an app-specific password at account.apple.com → Sign-In and Security.
5. Add these repository secrets to getcockpit/cockpit:

   | Secret | Value |
   |---|---|
   | `APPLE_CERTIFICATE` | the base64 `.p12` |
   | `APPLE_CERTIFICATE_PASSWORD` | its export password |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | the 10-character team id |

6. Tag a release. The macOS job signs, notarises and staples.
7. Drop the `xattr` line from `site/index.html`, `site/install.sh` and `docs/INSTALL.md`.

## Windows (later)

- SmartScreen warnings fade as a signed binary builds reputation.
- Cheapest options: **Azure Trusted Signing** (about $10 a month) or **SignPath Foundation** (free for open source, needs an application).
- Both plug into the Windows job in `release.yml`. Not wired yet.

## Linux

AppImage, `.deb` and `.rpm` don't need signing to install. Nothing to do.
