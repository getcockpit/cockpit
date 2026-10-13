// mr-dictate on Linux and Windows: push-to-talk uses Apple's on-device speech recognizer, so
// elsewhere the helper only says so, in the same one-JSON-per-line protocol as main.swift.
console.log(JSON.stringify({ type: "error", error: "Voice input is macOS-only for now." }));
