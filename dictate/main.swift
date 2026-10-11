// mr-dictate: push-to-talk speech-to-text for Cockpit, on device.
// Prints one JSON object per line: {"type":"ready"|"partial"|"final"|"error"|"status", ...}.
// Starts listening immediately; a "stop" line on stdin (or EOF) ends it and prints the final text.
// `mr-dictate --status` only reports permissions and on-device support, without recording.
//
// Uses SFSpeechRecognizer with on-device recognition required (the installed SDK predates
// SpeechAnalyzer); swapping to SpeechAnalyzer later only changes this file.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
}

let locale = Locale(identifier: ProcessInfo.processInfo.environment["MR_DICTATE_LOCALE"] ?? "en-US")
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    emit(["type": "error", "error": "no recognizer for \(locale.identifier)"])
    exit(1)
}

func authName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}

if CommandLine.arguments.contains("--status") {
    emit(["type": "status", "speech": authName(SFSpeechRecognizer.authorizationStatus()), "on_device": recognizer.supportsOnDeviceRecognition, "available": recognizer.isAvailable, "locale": locale.identifier])
    exit(0)
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
var lastText = ""
var finished = false

func finish(_ text: String) {
    if finished { return }
    finished = true
    emit(["type": "final", "text": text])
    exit(0)
}

func stopListening() {
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    request.endAudio()
    // If the recognizer never sends a final result, end with what we have.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { finish(lastText) }
}

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        emit(["type": "error", "error": "speech recognition not allowed (\(authName(status))). Allow it in System Settings → Privacy & Security."])
        exit(2)
    }
    DispatchQueue.main.async {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
        engine.prepare()
        do { try engine.start() } catch {
            emit(["type": "error", "error": "microphone: \(error.localizedDescription)"])
            exit(3)
        }
        emit(["type": "ready", "on_device": request.requiresOnDeviceRecognition])
        recognizer.recognitionTask(with: request) { result, error in
            if let r = result {
                lastText = r.bestTranscription.formattedString
                if r.isFinal { finish(lastText) } else { emit(["type": "partial", "text": lastText]) }
            } else if let e = error {
                if !lastText.isEmpty { finish(lastText) } else {
                    // Apple's recognizer refuses to run while system Dictation is off; say where to turn it on.
                    let msg = e.localizedDescription.contains("Siri and Dictation are disabled")
                        ? "Dictation is off. Turn it on in System Settings → Keyboard → Dictation, then try again."
                        : e.localizedDescription
                    emit(["type": "error", "error": msg]); exit(4)
                }
            }
        }
    }
}

// Read stdin on a background thread; "stop" or EOF ends listening.
Thread.detachNewThread {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
    }
    DispatchQueue.main.async { stopListening() }
}

RunLoop.main.run()
