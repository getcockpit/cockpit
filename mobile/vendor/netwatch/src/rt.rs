//! Cockpit Remote patch (mobile/vendor/README.md): `libc` 0.2.190+ defines the BSD route-socket
//! constants for macOS only, but iOS runs the same XNU kernel with the same `net/route.h` values
//! (copied here from libc 0.2.191's macOS definitions). macOS keeps taking them from `libc`.

#[cfg(target_os = "macos")]
pub use libc::{RTA_IFP, RTAX_BRD, RTAX_DST, RTAX_GATEWAY, RTAX_MAX, RTAX_NETMASK, RTF_GATEWAY, RTAX_IFP, RTM_VERSION, RTM_ADD, RTM_DELETE, RTM_CHANGE, RTM_GET, RTM_LOSING, RTM_REDIRECT, RTM_MISS, RTM_LOCK, RTM_RESOLVE, RTM_NEWADDR, RTM_DELADDR, RTM_IFINFO, RTM_NEWMADDR, RTM_DELMADDR, RTM_IFINFO2, RTM_NEWMADDR2, RTM_GET2, RTF_IFSCOPE};

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
mod values {
    #[allow(unused_imports)]
    use libc::{c_int, c_uint};
    pub const RTA_IFP: c_int = 0x10;
    pub const RTAX_BRD: c_int = 7;
    pub const RTAX_DST: c_int = 0;
    pub const RTAX_GATEWAY: c_int = 1;
    pub const RTAX_MAX: c_int = 8;
    pub const RTAX_NETMASK: c_int = 2;
    pub const RTF_GATEWAY: c_int = 0x2;
    pub const RTAX_IFP: c_int = 4;
    pub const RTM_VERSION: c_int = 5;
    pub const RTM_ADD: c_int = 0x1;
    pub const RTM_DELETE: c_int = 0x2;
    pub const RTM_CHANGE: c_int = 0x3;
    pub const RTM_GET: c_int = 0x4;
    pub const RTM_LOSING: c_int = 0x5;
    pub const RTM_REDIRECT: c_int = 0x6;
    pub const RTM_MISS: c_int = 0x7;
    pub const RTM_LOCK: c_int = 0x8;
    pub const RTM_RESOLVE: c_int = 0xb;
    pub const RTM_NEWADDR: c_int = 0xc;
    pub const RTM_DELADDR: c_int = 0xd;
    pub const RTM_IFINFO: c_int = 0xe;
    pub const RTM_NEWMADDR: c_int = 0xf;
    pub const RTM_DELMADDR: c_int = 0x10;
    pub const RTM_IFINFO2: c_int = 0x12;
    pub const RTM_NEWMADDR2: c_int = 0x13;
    pub const RTM_GET2: c_int = 0x14;
    pub const RTF_IFSCOPE: c_int = 0x1000000;
}
#[cfg(not(target_os = "macos"))]
pub use values::*;
