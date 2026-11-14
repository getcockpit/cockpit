# Vendored crates (iOS build only)

iroh 1.4.1's network crates use `libc` items that `libc` 0.2.190+ defines for macOS only, so they
don't compile for iOS (and `mio` needs that newer `libc`, so pinning an older one isn't possible).
Both copies are the registry release plus the changes marked "Cockpit Remote patch". They're wired
in by `[patch.crates-io]` in `mobile/src-tauri/Cargo.toml`; the desktop app builds the registry
crates. Drop them once iroh moves to versions that build for iOS.

- `netdev` 0.46.3 (MIT): `libc::in6_ifreq`. On iOS `get_ipv6_addr_flags` returns the defaults, as on
  Linux (`src/interface/ipv6_addr_flags.rs`, `src/os/darwin/mod.rs`); the flags only rank addresses.
- `netwatch` 0.19.3 (MIT/Apache-2.0): the BSD route-socket constants (`RTM_*`, `RTAX_*`, `RTF_*`).
  `src/rt.rs` re-exports them from `libc` on macOS and defines the same XNU `net/route.h` values on
  iOS; `src/interfaces/bsd.rs`, `src/interfaces/bsd/macos.rs` and `src/netmon/bsd.rs` use it.
