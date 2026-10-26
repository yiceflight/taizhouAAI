// The user starts this client for continuous monitoring, including while its
// window is minimized or hidden in the tray. Keep the activity on the main
// thread for the run-loop lifetime; the opaque Cocoa token is not Send/Sync.
#[cfg(target_os = "macos")]
pub struct BackgroundActivity(
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
);

#[cfg(target_os = "macos")]
impl BackgroundActivity {
    pub fn begin() -> Self {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        Self(NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &NSString::from_str("持续监测：浏览器心跳、平台验证与指标采集"),
        ))
    }
}

#[cfg(target_os = "macos")]
impl Drop for BackgroundActivity {
    fn drop(&mut self) {
        // SAFETY: this is the activity token returned by beginActivity above.
        unsafe { objc2_foundation::NSProcessInfo::processInfo().endActivity(&self.0) };
    }
}
