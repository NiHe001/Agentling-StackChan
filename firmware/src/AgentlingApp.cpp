#include "AgentlingApp.h"
#include "ServoFeedback.h"

#include <LittleFS.h>
#include <SD.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <esp_camera.h>
#include <img_converters.h>

namespace agentling {

namespace {

constexpr uint8_t LTR553_ADDRESS = 0x23;
constexpr uint8_t LTR553_ALS_CONTR = 0x80;
constexpr uint8_t LTR553_PS_CONTR = 0x81;
constexpr uint8_t LTR553_ALS_DATA_CH1_0 = 0x88;
constexpr uint32_t SENSOR_I2C_HZ = 400000;
constexpr size_t CAMERA_CHUNK_BYTES = 2048;
constexpr uint32_t CAMERA_CONSENT_MS = 15000;
constexpr uint32_t SERVO_COMMAND_COOLDOWN_MS = 1000;
// Verified against the independent vendor-driver baseline on this device.
constexpr bool SERVO_REMOTE_MOTION_ENABLED = true;

bool isHexColor(const String& value) {
    if (value.length() != 7 || value[0] != '#') return false;
    for (size_t index = 1; index < value.length(); ++index) {
        const char character = value[index];
        if (!((character >= '0' && character <= '9') ||
              (character >= 'a' && character <= 'f') ||
              (character >= 'A' && character <= 'F'))) return false;
    }
    return true;
}

bool readNullableNumber(CborReader& reader, double& value) {
    if (reader.peekMajor() == 7 && reader.readNull()) return false;
    return reader.readNumber(value);
}

String readTextOrEmpty(CborReader& reader) {
    String value;
    if (reader.peekMajor() == 7 && reader.readNull()) return value;
    reader.readText(value);
    return value;
}

int valueOr(JsonObjectConst primary, JsonObjectConst fallback, const char* key, int defaultValue) {
    if (!primary.isNull() && primary[key].is<int>()) return primary[key].as<int>();
    if (!fallback.isNull() && fallback[key].is<int>()) return fallback[key].as<int>();
    return defaultValue;
}

const char* textOr(JsonObjectConst primary, JsonObjectConst fallback, const char* key, const char* defaultValue) {
    if (!primary.isNull() && primary[key].is<const char*>()) return primary[key].as<const char*>();
    if (!fallback.isNull() && fallback[key].is<const char*>()) return fallback[key].as<const char*>();
    return defaultValue;
}

}  // namespace

void AgentlingApp::begin() {
    auto config = M5.config();
    config.clear_display = true;
    config.output_power = true;
    M5StackChan.begin();
    // The BSP adapter leaves servo power off throughout boot.
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(false);
    environmentSensorReady_ = beginEnvironmentSensor();
    // Build every frame away from the LCD, then transfer it in one operation.
    // CoreS3 has PSRAM and M5Canvas uses it by default, so a 320x240 RGB565
    // frame does not consume the small internal heap.
    canvas_.setColorDepth(16);
    canvasReady_ = canvas_.createSprite(320, 240) != nullptr;
    // Arduino-ESP32's HWCDC defaults to a 256-byte RX queue. Protocol
    // manifests and pack chunks are larger, so reserve enough room before the
    // port starts to avoid silently dropping the COBS frame terminator while
    // the display or flash storage is busy.
    Serial.setRxBufferSize(8 * 1024);
    Serial.begin(921600);
    protocol_.begin();
    packStore_.begin();
    hasPack_ = packStore_.loadRuntime(pack_);
    M5StackChan.showRgbColor(28, 90, 72);
    idleStartedAt_ = millis();
    render();
    delay(120);
    sendHello();
}

void AgentlingApp::update() {
    M5StackChan.update();
    if (updatePowerButton()) return;
    protocol_.poll(Serial, [this](const EnvelopeView& envelope) {
        handleEnvelope(envelope);
        protocol_.send(Serial, "ack", [&envelope](CborWriter& writer) {
            writer.map(1);
            writer.key("sequence"); writer.unsignedInteger(envelope.sequence);
        });
    });
    updateBehavior();
    updateSound();
    updateLight();
    updateVisual();
    updateTouch();
    updateHeadTouch();
    updatePhysicalSensors();
    updateServoMotion();
    updateCameraConsent();
    updateIdle();
    if (hostOnline_ && millis() - lastHostMessageAt_ > 15'000) {
        if (servoPhase_) finishServoMotion(false, "host disconnected");
        hostOnline_ = false;
        state_ = "offline";
        statusMessage_ = stateLabel(state_);
        renderDirty_ = true;
    }
    if (renderDirty_ && millis() - lastRenderAt_ >= 16) render();
}

void AgentlingApp::handleEnvelope(const EnvelopeView& envelope) {
    lastHostMessageAt_ = millis();
    hostOnline_ = true;
    if (hostEpoch_ != envelope.epoch) {
        hostEpoch_ = envelope.epoch;
        lastHostSequence_ = 0;
    }
    if (envelope.sequence <= lastHostSequence_) return;
    lastHostSequence_ = envelope.sequence;
    CborReader payload(envelope.payload);
    if (envelope.type == "device.hello") sendHello();
    else if (envelope.type == "agent.snapshot") {
        if (parseAgentSnapshot(payload)) renderDirty_ = true;
    } else if (envelope.type == "widget.snapshot") {
        parseWidgetSnapshot(payload);
        renderDirty_ = true;
    } else if (envelope.type == "action.cue") {
        parseActionCue(payload);
        renderDirty_ = true;
    }
    else if (envelope.type == "pack.manifest") parsePackManifest(payload);
    else if (envelope.type == "pack.chunk") parsePackChunk(payload);
    else if (envelope.type == "pack.commit") {
        parsePackCommit(payload);
        renderDirty_ = true;
    }
    else if (envelope.type == "pack.activate") {
        parsePackActivate(payload);
        renderDirty_ = true;
    }
    else if (envelope.type == "sensor.request") parseSensorRequest(payload);
    else if (envelope.type == "camera.request") parseCameraRequest(payload);
    else if (envelope.type == "hardware.light") parseLightCommand(payload);
    else if (envelope.type == "hardware.sound") parseSoundCommand(payload);
    else if (envelope.type == "hardware.servo") parseServoCommand(payload);
    else if (envelope.type == "hardware.servo.home") parseServoHomeCommand(payload);
    else if (envelope.type == "hardware.servo.inspect") parseServoInspectCommand(payload);
}

bool AgentlingApp::parseAgentSnapshot(CborReader& reader) {
    const String previousState = state_;
    const String previousActiveTaskId = activeTaskId_;
    const String previousActiveTaskTitle = activeTaskTitle_;
    const String previousActiveTaskReport = activeTaskReport_;
    const String previousStatusMessage = statusMessage_;
    const size_t previousTaskCount = taskCount_;
    size_t fields;
    if (!reader.readMapSize(fields)) return false;
    taskCount_ = 0;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return false;
        if (key == "tasks") {
            size_t count;
            if (!reader.readArraySize(count)) return false;
            for (size_t taskIndex = 0; taskIndex < count; ++taskIndex) {
                size_t taskFields;
                if (!reader.readMapSize(taskFields)) return false;
                TaskValue task;
                for (size_t field = 0; field < taskFields; ++field) {
                    String taskKey;
                    if (!reader.readText(taskKey)) return false;
                    if (taskKey == "id") reader.readText(task.id);
                    else if (taskKey == "title") reader.readText(task.title);
                    else if (taskKey == "state") reader.readText(task.state);
                    else if (taskKey == "currentTool") task.currentTool = readTextOrEmpty(reader);
                    else if (taskKey == "message") task.message = readTextOrEmpty(reader);
                    else if (taskKey == "subagents") {
                        uint64_t value = 0;
                        if (!reader.readUnsigned(value)) return false;
                        task.subagents = static_cast<uint8_t>(value > 255 ? 255 : value);
                    } else if (!reader.skipValue()) return false;
                }
                if (taskCount_ < tasks_.size()) tasks_[taskCount_++] = task;
            }
        } else if (key == "activeTaskId") activeTaskId_ = readTextOrEmpty(reader);
        else if (key == "aggregateState") reader.readText(state_);
        else if (!reader.skipValue()) return false;
    }
    activeTaskTitle_ = "";
    activeTaskReport_ = "";
    for (size_t index = 0; index < taskCount_; ++index) {
        if (tasks_[index].id == activeTaskId_) {
            activeTaskTitle_ = tasks_[index].title;
            activeTaskReport_ = tasks_[index].message;
        }
    }
    // The header identifies the selected task; the status row reports what it
    // just did. Critical lifecycle truth always remains explicit.
    const String lifecycle = stateLabel(state_);
    if (state_ == "idle" || state_ == "offline") statusMessage_ = lifecycle;
    else if (activeTaskReport_.isEmpty()) statusMessage_ = lifecycle;
    else if ((state_ == "waiting_approval" || state_ == "needs_input" || state_ == "failed") &&
             activeTaskReport_.indexOf(lifecycle) < 0) {
        statusMessage_ = lifecycle + " · " + activeTaskReport_;
    } else statusMessage_ = activeTaskReport_;
    if (state_ == "idle") {
        if (!idleStartedAt_) idleStartedAt_ = millis();
    } else idleStartedAt_ = 0;
    if (previousState != state_) {
        behaviorName_ = "";
        if (!overlayActive_) restoreStateBehavior();
    }
    return previousState != state_ ||
        previousActiveTaskId != activeTaskId_ ||
        previousActiveTaskTitle != activeTaskTitle_ ||
        previousActiveTaskReport != activeTaskReport_ ||
        previousStatusMessage != statusMessage_ ||
        previousTaskCount != taskCount_;
}

void AgentlingApp::parseWidgetSnapshot(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "usage") parseUsage(reader);
        else if (key == "clock") parseClock(reader);
        else if (key == "weather") parseWeather(reader);
        else if (!reader.skipValue()) return;
    }
}

void AgentlingApp::parseUsage(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    quotaCount_ = 0;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "windows") {
            size_t count;
            if (!reader.readArraySize(count)) return;
            for (size_t windowIndex = 0; windowIndex < count; ++windowIndex) {
                size_t windowFields;
                if (!reader.readMapSize(windowFields)) return;
                QuotaValue quota;
                for (size_t field = 0; field < windowFields; ++field) {
                    String windowKey;
                    if (!reader.readText(windowKey)) return;
                    if (windowKey == "id") reader.readText(quota.id);
                    else if (windowKey == "remainingPercent") {
                        double number;
                        quota.remaining = readNullableNumber(reader, number) ? static_cast<float>(number) : -1;
                    } else if (windowKey == "resetsAt") {
                        double number;
                        quota.resetsAt = readNullableNumber(reader, number) ? static_cast<uint64_t>(number) : 0;
                    } else if (windowKey == "stale") reader.readBool(quota.stale);
                    else if (!reader.skipValue()) return;
                }
                if (quotaCount_ < quotas_.size()) quotas_[quotaCount_++] = quota;
            }
        } else if (key == "aliases") {
            size_t aliasCount;
            if (!reader.readMapSize(aliasCount)) return;
            for (size_t aliasIndex = 0; aliasIndex < aliasCount; ++aliasIndex) {
                String alias;
                reader.readText(alias);
                String id = readTextOrEmpty(reader);
                if (alias == "five_hour") fiveHourId_ = id;
                else if (alias == "weekly") weeklyId_ = id;
            }
        } else if (!reader.skipValue()) return;
    }
}

void AgentlingApp::parseClock(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String iso;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "displayTime") reader.readText(localTime_);
        else if (key == "iso") reader.readText(iso);
        else if (!reader.skipValue()) return;
    }
    if (localTime_ == "--:--" && iso.length() >= 16) localTime_ = iso.substring(11, 16);
}

void AgentlingApp::parseWeather(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "temperatureC") {
            double number;
            temperatureC_ = readNullableNumber(reader, number) ? static_cast<float>(number) : NAN;
        } else if (key == "label") reader.readText(weatherLabel_);
        else if (!reader.skipValue()) return;
    }
}

void AgentlingApp::parseActionCue(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String behavior;
    bool overlaySeen = false;
    String overlayScene;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "behavior") behavior = readTextOrEmpty(reader);
        else if (key == "overlay") {
            overlaySeen = true;
            if (reader.peekMajor() == 7 && reader.readNull()) {
                overlayActive_ = false;
                overlayText_ = "";
            } else {
                overlayActive_ = true;
                overlayText_ = "";
                size_t overlayFields;
                if (!reader.readMapSize(overlayFields)) return;
                for (size_t field = 0; field < overlayFields; ++field) {
                    String overlayKey;
                    reader.readText(overlayKey);
                    if (overlayKey == "scene") {
                        reader.readText(overlayScene);
                    }
                    else if (overlayKey == "text") overlayText_ = readTextOrEmpty(reader);
                    else reader.skipValue();
                }
            }
        } else if (!reader.skipValue()) return;
    }
    if (!behavior.isEmpty()) startBehavior(behavior);
    if (overlaySeen) {
        if (overlayActive_) setExpression(overlayScene);
        else if (behaviorName_.isEmpty()) restoreStateBehavior();
        else setExpression(expressionForState());
    }
}

void AgentlingApp::parsePackManifest(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String id, version, digest;
    std::vector<ExpectedFile> files;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        reader.readText(key);
        if (key == "id") reader.readText(id);
        else if (key == "version") reader.readText(version);
        else if (key == "digest") reader.readText(digest);
        else if (key == "files") {
            size_t count;
            if (!reader.readArraySize(count)) return;
            files.reserve(count);
            for (size_t fileIndex = 0; fileIndex < count; ++fileIndex) {
                size_t fileFields;
                if (!reader.readMapSize(fileFields)) return;
                ExpectedFile file;
                for (size_t field = 0; field < fileFields; ++field) {
                    String fileKey;
                    reader.readText(fileKey);
                    if (fileKey == "path") reader.readText(file.path);
                    else if (fileKey == "size") {
                        uint64_t size;
                        reader.readUnsigned(size);
                        file.size = static_cast<size_t>(size);
                    } else if (fileKey == "sha256") reader.readText(file.sha256);
                    else reader.skipValue();
                }
                files.push_back(file);
            }
        } else reader.skipValue();
    }
    if (!packStore_.beginTransaction(id, version, digest, files)) sendError(packStore_.error());
}

void AgentlingApp::parsePackChunk(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String path;
    uint64_t offset = 0;
    std::vector<uint8_t> data;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        reader.readText(key);
        if (key == "path") reader.readText(path);
        else if (key == "offset") reader.readUnsigned(offset);
        else if (key == "data") reader.readBytes(data);
        else reader.skipValue();
    }
    if (!packStore_.writeChunk(path, static_cast<size_t>(offset), data)) sendError(packStore_.error());
}

void AgentlingApp::parsePackCommit(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String id, version;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        reader.readText(key);
        if (key == "id") reader.readText(id);
        else if (key == "version") reader.readText(version);
        else reader.skipValue();
    }
    if (!packStore_.commit(id, version)) {
        sendError(packStore_.error());
        return;
    }
    pack_.clear();
    hasPack_ = packStore_.loadRuntime(pack_);
    startBehavior("wake");
    if (!hasPack_) sendError(packStore_.error());
}

void AgentlingApp::parsePackActivate(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String id, version, digest;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "id") reader.readText(id);
        else if (key == "version") reader.readText(version);
        else if (key == "digest") reader.readText(digest);
        else if (!reader.skipValue()) return;
    }
    // Cache misses are normal: the desktop then sends the pack once.
    if (!packStore_.activateCached(id, version, digest)) return;
    pack_.clear();
    hasPack_ = packStore_.loadRuntime(pack_);
    if (hasPack_) startBehavior("wake");
    else sendError(packStore_.error());
}

void AgentlingApp::parseSensorRequest(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (!reader.skipValue()) return;
    }
    if (!requestId.isEmpty()) sendSensorSnapshot(requestId);
}

void AgentlingApp::parseCameraRequest(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (!reader.skipValue()) return;
    }
    if (requestId.isEmpty()) return;
    if (cameraConsentPending_ || cameraCapturing_) {
        sendCameraResult(requestId, false, "camera busy");
        return;
    }
    cameraRequestId_ = requestId;
    cameraConsentPending_ = true;
    cameraConsentDeadline_ = millis() + CAMERA_CONSENT_MS;
    touchDown_ = false;
    renderDirty_ = true;
}

void AgentlingApp::parseLightCommand(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId, color, mode;
    double brightness = -1, periodMs = -1, ttlMs = -1;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (key == "color") reader.readText(color);
        else if (key == "mode") reader.readText(mode);
        else if (key == "brightness") reader.readNumber(brightness);
        else if (key == "periodMs") reader.readNumber(periodMs);
        else if (key == "ttlMs") reader.readNumber(ttlMs);
        else if (!reader.skipValue()) return;
    }
    const bool validMode = mode == "solid" || mode == "breathe" || mode == "pulse" || mode == "chase";
    if (requestId.isEmpty() || !isHexColor(color) || !validMode ||
        brightness < 0 || brightness > 80 || periodMs < 300 || periodMs > 5000 ||
        ttlMs < 1000 || ttlMs > 30000) {
        sendHardwareResult(requestId, "light", false, "invalid light parameters");
        return;
    }
    setDirectLight(parseColor(color.c_str(), 0), static_cast<uint8_t>(brightness), mode,
                   static_cast<uint32_t>(periodMs), static_cast<uint32_t>(ttlMs));
    sendHardwareResult(requestId, "light", true);
}

void AgentlingApp::parseSoundCommand(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId, preset;
    double volumePercent = -1, maxDurationMs = -1;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (key == "preset") reader.readText(preset);
        else if (key == "volumePercent") reader.readNumber(volumePercent);
        else if (key == "maxDurationMs") reader.readNumber(maxDurationMs);
        else if (!reader.skipValue()) return;
    }
    if (requestId.isEmpty() || preset.isEmpty() || volumePercent < 0 || volumePercent > 50 ||
        maxDurationMs < 100 || maxDurationMs > 3000) {
        sendHardwareResult(requestId, "sound", false, "invalid sound parameters");
        return;
    }
    if (!playSoundPreset(preset, static_cast<uint8_t>(volumePercent), static_cast<uint32_t>(maxDurationMs))) {
        sendHardwareResult(requestId, "sound", false, "unknown sound preset");
        return;
    }
    sendHardwareResult(requestId, "sound", true);
}

void AgentlingApp::parseServoCommand(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId;
    double yawDegrees = NAN, pitchDegrees = NAN, speedPercent = NAN, holdMs = NAN;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (key == "yawDegrees") reader.readNumber(yawDegrees);
        else if (key == "pitchDegrees") reader.readNumber(pitchDegrees);
        else if (key == "speedPercent") reader.readNumber(speedPercent);
        else if (key == "holdMs") reader.readNumber(holdMs);
        else if (!reader.skipValue()) return;
    }
    if (requestId.isEmpty() || !isfinite(yawDegrees) || !isfinite(pitchDegrees) ||
        yawDegrees < -30 || yawDegrees > 30 || pitchDegrees < 0 || pitchDegrees > 20 ||
        !isfinite(speedPercent) || !isfinite(holdMs) ||
        speedPercent < 10 || speedPercent > 50 || holdMs < 300 || holdMs > 2000) {
        sendHardwareResult(requestId, "servo", false, "invalid servo parameters");
        return;
    }
    if (!SERVO_REMOTE_MOTION_ENABLED) {
        M5StackChan.Motion.setTorqueEnabled(false);
        M5StackChan.setServoPowerEnabled(false);
        servoPowerEnabled_ = false;
        sendHardwareResult(requestId, "servo", false,
                           "servo movement disabled: untrusted position feedback");
        return;
    }
    if (servoPhase_ != 0) {
        sendHardwareResult(requestId, "servo", false, "servo movement already active");
        return;
    }
    if (lastServoCompletedAt_ && millis() - lastServoCompletedAt_ < SERVO_COMMAND_COOLDOWN_MS) {
        sendHardwareResult(requestId, "servo", false, "servo cooldown active");
        return;
    }

    servoTargetYawTenths_ = static_cast<int>(round(yawDegrees * 10.0));
    servoTargetPitchTenths_ = static_cast<int>(round(pitchDegrees * 10.0));
    servoHoldMs_ = static_cast<uint32_t>(holdMs);
    servoRequestId_ = requestId;
    M5StackChan.setServoPowerEnabled(true);
    servoPowerEnabled_ = true;
    delay(2000); // Cold servo rail: 500 ms produced reproducible no-reply errors.
    if (!M5StackChan.Motion.prepareSafe()) {
        finishServoMotion(false, M5StackChan.Motion.safetyError());
        return;
    }
    const auto current = M5StackChan.Motion.getCurrentAngles();
    if (current.x == INVALID_SERVO_ANGLE || current.y == INVALID_SERVO_ANGLE) {
        finishServoMotion(false, "invalid feedback after preparation");
        return;
    }
    servoYawTenths_ = current.x;
    servoPitchTenths_ = current.y;
    // Program the controller with its physical position while torque is still
    // disabled. Enabling torque before this synchronization can make it snap
    // toward an old retained target.
    M5StackChan.Motion.setAutoAngleSyncEnabled(true);
    M5StackChan.Motion.setAutoTorqueReleaseEnabled(false);
    if (!M5StackChan.Motion.enablePreparedTorque()) {
        finishServoMotion(false, "torque enable verification failed");
        return;
    }
    // One official spring target, speed in the BSP's 0..1000 units.
    M5StackChan.Motion.move(servoTargetYawTenths_, servoTargetPitchTenths_,
                           static_cast<int>(speedPercent * 10));
    servoPhase_ = 1;
    servoLastStepAt_ = 0;
    servoNextAt_ = 0;
    servoDeadline_ = millis() + 20000;
}

void AgentlingApp::parseServoHomeCommand(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (!reader.skipValue()) return;
    }
    if (requestId.isEmpty()) return;
    if (servoPhase_ != 0) {
        sendHardwareResult(requestId, "servo_home", false, "servo movement already active");
        return;
    }
    sendHardwareResult(requestId, "servo_home", false,
                       "automatic recovery removed; default pose is a normal move to yaw=0 pitch=0 after bench validation");
}

void AgentlingApp::parseServoInspectCommand(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String requestId;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "requestId") reader.readText(requestId);
        else if (!reader.skipValue()) return;
    }
    if (requestId.isEmpty()) return;
    if (servoPhase_ != 0) {
        sendHardwareResult(requestId, "servo_inspect", false, "servo movement already active");
        return;
    }
    // Diagnostic only: force torque off, read back state, and always cut rail
    // power. This path never calls enablePreparedTorque or commands movement.
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(true);
    servoPowerEnabled_ = true;
    delay(2000);
    const String diagnostic = M5StackChan.Motion.inspectServos().c_str();
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(false);
    servoPowerEnabled_ = false;
    sendHardwareResult(requestId, "servo_inspect", true, diagnostic.c_str());
}

void AgentlingApp::sendHello() {
    protocol_.send(Serial, "device.hello", [this](CborWriter& writer) {
        writer.map(4);
        writer.key("diagnostics"); writer.map(23);
        writer.key("visualCount"); writer.unsignedInteger(pack_["visuals"].size());
        writer.key("visualRenderer"); writer.text(pack_["visuals"][expression_]["renderer"] | "missing");
        writer.key("visualFrame"); writer.unsignedInteger(visualFrameIndex_);
        writer.key("visualMotion"); writer.text(
            String("x=") + visualOffsetX_ + ";y=" + visualOffsetY_ + ";scale=" + visualScalePermille_);
        writer.key("visualPhase"); writer.unsignedInteger(visualPhaseStep_);
        writer.key("widgetCount"); writer.unsignedInteger(pack_["ui"]["layouts"]["base"]["widgets"].size());
        writer.key("packLoaded"); writer.boolean(hasPack_);
        writer.key("packId"); writer.text(pack_["manifest"]["id"] | "");
        writer.key("packVersion"); writer.text(pack_["manifest"]["version"] | "");
        writer.key("packDigest"); writer.text(packStore_.activeDigest());
        writer.key("storageBackend"); writer.text(packStore_.storageName());
        writer.key("sdMounted"); writer.boolean(packStore_.sdAvailable());
        writer.key("storageTotal"); writer.unsignedInteger(packStore_.totalBytes());
        writer.key("storageUsed"); writer.unsignedInteger(packStore_.usedBytes());
        writer.key("packError"); writer.text(packStore_.error());
        writer.key("expression"); writer.text(expression_);
        writer.key("renderedAsset"); writer.text(renderedAsset_);
        writer.key("renderError"); writer.text(renderError_);
        writer.key("state"); writer.text(state_);
        writer.key("statusMessage"); writer.text(statusMessage_);
        writer.key("activeTaskTitle"); writer.text(activeTaskTitle_);
        writer.key("activeTaskReport"); writer.text(activeTaskReport_);
        writer.key("localTime"); writer.text(localTime_);
        writer.key("firmwareVersion"); writer.text("0.8.0");
        writer.key("protocolVersion"); writer.unsignedInteger(AGENTLING_PROTOCOL_VERSION);
        writer.key("capabilities");
        writer.map(11);
        writer.key("display"); writer.map(3);
        writer.key("width"); writer.unsignedInteger(320);
        writer.key("height"); writer.unsignedInteger(240);
        writer.key("touch"); writer.boolean(true);
        writer.key("servo"); writer.map(2);
        writer.key("yaw"); writer.boolean(true);
        writer.key("pitch"); writer.boolean(true);
        writer.key("speaker"); writer.boolean(true);
        writer.key("rgbCount"); writer.unsignedInteger(12);
        writer.key("sdCard"); writer.boolean(packStore_.sdAvailable());
        writer.key("camera"); writer.boolean(true);
        writer.key("imu"); writer.boolean(M5.Imu.isEnabled());
        writer.key("ambientLight"); writer.boolean(environmentSensorReady_);
        writer.key("proximity"); writer.boolean(environmentSensorReady_);
        writer.key("headTouch"); writer.boolean(true);
        writer.key("battery"); writer.boolean(true);
    });
}

void AgentlingApp::sendInput(const char* type, const char* source) {
    protocol_.send(Serial, "input.event", [type, source](CborWriter& writer) {
        writer.map(3);
        writer.key("type"); writer.text(type);
        writer.key("source"); writer.text(source);
        writer.key("at"); writer.unsignedInteger(millis());
    });
}

void AgentlingApp::sendSensorSnapshot(const String& requestId) {
    M5.Imu.update();
    const bool imuAvailable = M5.Imu.isEnabled();
    const auto imu = M5.Imu.getImuData();
    const float batteryVoltage = M5StackChan.getBatteryVoltage();
    const float batteryCurrent = M5StackChan.getBatteryCurrent();
    const bool batteryAvailable = batteryVoltage > 0;
    const uint32_t deviceUptimeMs = millis();
    const auto head = M5StackChan.TouchSensor.getIntensities();
    uint8_t environment[7]{};
    const bool environmentAvailable = environmentSensorReady_ &&
        M5.In_I2C.readRegister(LTR553_ADDRESS, LTR553_ALS_DATA_CH1_0, environment, sizeof(environment), SENSOR_I2C_HZ);
    const uint16_t channel1 = static_cast<uint16_t>(environment[0] | (environment[1] << 8));
    const uint16_t channel0 = static_cast<uint16_t>(environment[2] | (environment[3] << 8));
    const uint16_t proximity = static_cast<uint16_t>(environment[5] | ((environment[6] & 0x07) << 8));

    protocol_.send(Serial, "sensor.snapshot", [&](CborWriter& writer) {
        writer.map(7);
        writer.key("requestId"); writer.text(requestId);
        writer.key("deviceUptimeMs"); writer.unsignedInteger(deviceUptimeMs);
        writer.key("battery"); writer.map(3);
        writer.key("voltageV"); batteryAvailable ? writer.number(batteryVoltage) : writer.nullValue();
        writer.key("currentA"); batteryAvailable ? writer.number(batteryCurrent) : writer.nullValue();
        writer.key("charging"); batteryAvailable ? writer.boolean(batteryCurrent < -0.005f) : writer.nullValue();
        writer.key("imu"); writer.map(4);
        writer.key("available"); writer.boolean(imuAvailable);
        auto vector = [&](const char* key, const m5::IMU_Class::imu_3d_t& value) {
            writer.key(key);
            if (!imuAvailable) { writer.nullValue(); return; }
            writer.map(3);
            writer.key("x"); writer.number(value.x);
            writer.key("y"); writer.number(value.y);
            writer.key("z"); writer.number(value.z);
        };
        vector("accelerationG", imu.accel);
        vector("gyroscopeDps", imu.gyro);
        vector("magnetometerUt", imu.mag);
        writer.key("environment"); writer.map(4);
        writer.key("available"); writer.boolean(environmentAvailable);
        writer.key("ambientChannel0"); environmentAvailable ? writer.unsignedInteger(channel0) : writer.nullValue();
        writer.key("ambientChannel1"); environmentAvailable ? writer.unsignedInteger(channel1) : writer.nullValue();
        writer.key("proximityRaw"); environmentAvailable ? writer.unsignedInteger(proximity) : writer.nullValue();
        writer.key("touch"); writer.map(2);
        writer.key("screenPressed"); writer.boolean(M5.Touch.getCount() > 0);
        writer.key("headZones"); writer.array(3);
        for (uint8_t value : head) writer.unsignedInteger(value);
        writer.key("motion"); writer.map(4);
        writer.key("servoPower"); writer.boolean(servoPowerEnabled_);
        writer.key("active"); writer.boolean(servoPhase_ != 0);
        writer.key("yawDegrees"); servoYawTenths_ == INVALID_SERVO_ANGLE ? writer.nullValue() : writer.number(servoYawTenths_ / 10.0);
        writer.key("pitchDegrees"); servoPitchTenths_ == INVALID_SERVO_ANGLE ? writer.nullValue() : writer.number(servoPitchTenths_ / 10.0);
    });
}

void AgentlingApp::sendCameraResult(const String& requestId, bool ok, const char* error,
                                    size_t totalBytes, size_t width, size_t height) {
    protocol_.send(Serial, "camera.result", [&](CborWriter& writer) {
        writer.map(7);
        writer.key("requestId"); writer.text(requestId);
        writer.key("ok"); writer.boolean(ok);
        writer.key("error"); error ? writer.text(error) : writer.nullValue();
        writer.key("totalBytes"); writer.unsignedInteger(totalBytes);
        writer.key("width"); writer.unsignedInteger(width);
        writer.key("height"); writer.unsignedInteger(height);
        writer.key("mimeType"); writer.text("image/jpeg");
    });
}

void AgentlingApp::sendHardwareResult(const String& requestId, const char* command, bool ok,
                                      const char* error) {
    protocol_.send(Serial, "hardware.result", [&](CborWriter& writer) {
        const bool servo = strcmp(command, "servo") == 0;
        writer.map(servo ? 5 : 4);
        writer.key("requestId"); writer.text(requestId);
        writer.key("command"); writer.text(command);
        writer.key("ok"); writer.boolean(ok);
        writer.key("error"); error ? writer.text(error) : writer.nullValue();
        if (servo) {
            writer.key("measuredBeforeRelease"); writer.map(2);
            writer.key("yawDegrees"); servoYawTenths_ == INVALID_SERVO_ANGLE ? writer.nullValue() : writer.number(servoYawTenths_ / 10.0);
            writer.key("pitchDegrees"); servoPitchTenths_ == INVALID_SERVO_ANGLE ? writer.nullValue() : writer.number(servoPitchTenths_ / 10.0);
        }
    });
}

void AgentlingApp::sendError(const String& message) {
    protocol_.send(Serial, "error", [&message](CborWriter& writer) {
        writer.map(1);
        writer.key("message"); writer.text(message);
    });
}

bool AgentlingApp::beginEnvironmentSensor() {
    if (!M5.In_I2C.scanID(LTR553_ADDRESS, SENSOR_I2C_HZ)) return false;
    const bool als = M5.In_I2C.writeRegister8(LTR553_ADDRESS, LTR553_ALS_CONTR, 0x01, SENSOR_I2C_HZ);
    const bool proximity = M5.In_I2C.writeRegister8(LTR553_ADDRESS, LTR553_PS_CONTR, 0x03, SENSOR_I2C_HZ);
    return als && proximity;
}

bool AgentlingApp::captureCamera(const String& requestId) {
    camera_config_t config{};
    config.pin_pwdn = -1;
    config.pin_reset = -1;
    config.pin_xclk = 2;
    config.pin_sccb_sda = -1;
    config.pin_sccb_scl = -1;
    config.pin_d7 = 47;
    config.pin_d6 = 48;
    config.pin_d5 = 16;
    config.pin_d4 = 15;
    config.pin_d3 = 42;
    config.pin_d2 = 41;
    config.pin_d1 = 40;
    config.pin_d0 = 39;
    config.pin_vsync = 46;
    config.pin_href = 38;
    config.pin_pclk = 45;
    config.xclk_freq_hz = 20000000;
    config.ledc_timer = LEDC_TIMER_0;
    config.ledc_channel = LEDC_CHANNEL_0;
    config.pixel_format = PIXFORMAT_RGB565;
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 16;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    config.sccb_i2c_port = M5.In_I2C.getPort();

    const esp_err_t initialized = esp_camera_init(&config);
    if (initialized != ESP_OK) {
        sendCameraResult(requestId, false, "camera initialization failed");
        return false;
    }

    camera_fb_t* frame = nullptr;
    for (int index = 0; index < 3; ++index) {
        if (frame) esp_camera_fb_return(frame);
        frame = esp_camera_fb_get();
        if (!frame) break;
    }
    if (!frame) {
        esp_camera_deinit();
        sendCameraResult(requestId, false, "camera frame unavailable");
        return false;
    }

    uint8_t* jpeg = nullptr;
    size_t jpegSize = 0;
    const size_t width = frame->width;
    const size_t height = frame->height;
    const bool converted = frame2jpg(frame, 80, &jpeg, &jpegSize);
    esp_camera_fb_return(frame);
    esp_camera_deinit();
    if (!converted || !jpeg || jpegSize == 0 || jpegSize > 1024 * 1024) {
        if (jpeg) free(jpeg);
        sendCameraResult(requestId, false, "JPEG conversion failed");
        return false;
    }

    for (size_t offset = 0; offset < jpegSize; offset += CAMERA_CHUNK_BYTES) {
        const size_t size = std::min(CAMERA_CHUNK_BYTES, jpegSize - offset);
        protocol_.send(Serial, "camera.chunk", [&](CborWriter& writer) {
            writer.map(3);
            writer.key("requestId"); writer.text(requestId);
            writer.key("offset"); writer.unsignedInteger(offset);
            writer.key("data"); writer.bytes(jpeg + offset, size);
        });
        delay(2);
    }
    sendCameraResult(requestId, true, nullptr, jpegSize, width, height);
    free(jpeg);
    return true;
}

void AgentlingApp::finishCameraConsent() {
    cameraConsentPending_ = false;
    cameraCapturing_ = false;
    cameraConsentDeadline_ = 0;
    cameraRequestId_ = "";
    renderDirty_ = true;
}

LovyanGFX& AgentlingApp::renderTarget() {
    if (canvasReady_) return canvas_;
    return M5.Display;
}

String AgentlingApp::sceneForState() const {
    if (state_ == "failed" || state_ == "waiting_approval") return "critical";
    if (state_ == "offline") return pack_["ui"]["layouts"]["offline"].isNull() ? "critical" : "offline";
    if (state_ == "completed") return pack_["ui"]["layouts"]["completed"].isNull() ? "base" : "completed";
    if (state_ == "needs_input") return "waiting";
    if (state_ == "working") return "working";
    if (state_ == "idle") return "idle";
    return "base";
}

String AgentlingApp::expressionForState() const {
    auto available = [this](const char* name) { return !pack_["visuals"][name].isNull(); };
    if (state_ == "working") return available("working") ? "working" : "focused";
    if (state_ == "waiting_approval" || state_ == "needs_input") {
        return available("waiting_approval") ? "waiting_approval" : "alert";
    }
    if (state_ == "completed") return available("completed") ? "completed" : "happy";
    if (state_ == "failed") return available("failed") ? "failed" : "worried";
    if (state_ == "offline") return available("offline") ? "offline" : "sleeping";
    return available("idle") ? "idle" : "resting";
}

void AgentlingApp::render() {
    lastRenderAt_ = millis();
    renderDirty_ = false;
    LovyanGFX& display = renderTarget();
    display.startWrite();
    display.fillScreen(0x0841);
    if (hasPack_) renderConfigured();
    else renderFallback();
    if (!hostOnline_ && (!hasPack_ || sceneForState() != "offline")) {
        display.fillRoundRect(244, 5, 68, 18, 4, 0x5000);
        display.setTextColor(TFT_WHITE, 0x5000);
        display.setFont(&fonts::efontCN_10_b);
        display.setTextSize(1);
        display.setTextDatum(middle_center);
        display.drawString("HOST OFF", 278, 14);
    }
    if (cameraConsentPending_ || cameraCapturing_) renderCameraConsent();
    display.endWrite();
    if (canvasReady_) canvas_.pushSprite(0, 0);
}

void AgentlingApp::renderCameraConsent() {
    LovyanGFX& display = renderTarget();
    display.fillRoundRect(8, 35, 304, 194, 14, display.color565(14, 20, 31));
    display.drawRoundRect(8, 35, 304, 194, 14, display.color565(255, 184, 77));
    display.setTextDatum(middle_center);
    display.setTextColor(TFT_WHITE);
    display.setFont(&fonts::efontCN_16);
    display.drawString(cameraCapturing_ ? "正在拍照" : "允许拍摄一张照片？", 160, 78);
    display.setFont(&fonts::efontCN_12);
    display.setTextColor(display.color565(174, 187, 205));
    display.drawString(cameraCapturing_ ? "请保持设备稳定" : "照片仅保存到本机临时目录", 160, 111);
    if (cameraCapturing_) return;
    display.fillRoundRect(18, 169, 132, 44, 10, display.color565(76, 86, 104));
    display.fillRoundRect(170, 169, 132, 44, 10, display.color565(43, 150, 103));
    display.setFont(&fonts::efontCN_16);
    display.setTextColor(TFT_WHITE);
    display.drawString("拒绝", 84, 191);
    display.drawString("允许", 236, 191);
}

void AgentlingApp::renderConfigured() {
    JsonObjectConst layouts = pack_["ui"]["layouts"].as<JsonObjectConst>();
    JsonObjectConst scene = layouts[sceneForState()].as<JsonObjectConst>();
    if (scene.isNull()) scene = layouts["base"].as<JsonObjectConst>();
    for (JsonObjectConst widget : scene["widgets"].as<JsonArrayConst>()) {
        renderWidget(widget, JsonObjectConst());
    }
}

void AgentlingApp::renderWidget(JsonObjectConst widget, JsonObjectConst overrideValue) {
    bool visible = !overrideValue.isNull() && overrideValue["visible"].is<bool>()
        ? overrideValue["visible"].as<bool>() : widget["visible"] | true;
    if (!visible) return;
    JsonObjectConst rect = widget["rect"].as<JsonObjectConst>();
    JsonObjectConst overrideRect = overrideValue["rect"].as<JsonObjectConst>();
    int x = valueOr(overrideRect, rect, "x", 0);
    int y = valueOr(overrideRect, rect, "y", 0);
    int width = valueOr(overrideRect, rect, "width", 20);
    int height = valueOr(overrideRect, rect, "height", 12);
    JsonObjectConst style = widget["style"].as<JsonObjectConst>();
    JsonObjectConst overrideStyle = overrideValue["style"].as<JsonObjectConst>();
    const char* foreground = textOr(overrideStyle, style, "foreground", "#F5F7FB");
    const char* background = textOr(overrideStyle, style, "background", "#000000");
    uint32_t fg = parseColor(foreground, 0xf5f7fb);
    uint32_t bg = parseColor(background, 0x000000);
    int fontSize = valueOr(overrideStyle, style, "fontSize", 10);
    LovyanGFX& display = renderTarget();
    if (widget["style"]["background"].is<const char*>() || overrideStyle["background"].is<const char*>()) {
        display.fillRoundRect(x, y, width, height, valueOr(overrideStyle, style, "radius", 0), display.color565(bg >> 16, bg >> 8, bg));
    }
    bool hasBackground = widget["style"]["background"].is<const char*>() || overrideStyle["background"].is<const char*>();
    uint16_t foregroundColor = display.color565(fg >> 16, fg >> 8, fg);
    uint16_t backgroundColor = display.color565(bg >> 16, bg >> 8, bg);
    if (hasBackground) display.setTextColor(foregroundColor, backgroundColor);
    else display.setTextColor(foregroundColor);
    if (fontSize >= 22) display.setFont(&fonts::efontCN_24_b);
    else if (fontSize >= 16) display.setFont(&fonts::efontCN_16);
    else if (fontSize >= 14) display.setFont(&fonts::efontCN_14);
    else if (fontSize >= 12) display.setFont(&fonts::efontCN_12);
    else display.setFont(&fonts::efontCN_10);
    display.setTextSize(1);
    const char* alignment = textOr(overrideStyle, style, "align", "left");
    int textX = x + 3;
    if (strcmp(alignment, "center") == 0) {
        display.setTextDatum(middle_center);
        textX = x + width / 2;
    } else if (strcmp(alignment, "right") == 0) {
        display.setTextDatum(middle_right);
        textX = x + width - 3;
    } else display.setTextDatum(middle_left);
    String type = widget["widget"] | "";
    JsonObjectConst props = widget["props"].as<JsonObjectConst>();
    display.setClipRect(x, y, width, height);
    if (type == "sprite") renderFace(x, y, width, height);
    else if (type == "clock") display.drawString(localTime_, textX, y + height / 2);
    else if (type == "weather") {
        String value = isnan(temperatureC_) ? "天气 --" : String(static_cast<int>(round(temperatureC_))) + "° " + weatherLabel_;
        display.drawString(value, textX, y + height / 2);
    } else if (type == "agent_badge") display.drawString(props["label"] | "CODEX", textX, y + height / 2);
    else if (type == "task_count") {
        String value = taskCount_ ? activeTaskTitle_ : String(props["empty_text"] | "等待任务");
        if (taskCount_ && taskCount_ > 1) {
            size_t activeIndex = 0;
            for (size_t index = 0; index < taskCount_; ++index) {
                if (tasks_[index].id == activeTaskId_) activeIndex = index;
            }
            value += "  " + String(activeIndex + 1) + "/" + String(taskCount_);
        }
        display.drawString(value, textX, y + height / 2);
    }
    else if (type == "status_text") {
        const char* mode = props["mode"] | "detail";
        String value = !overlayText_.isEmpty()
            ? overlayText_
            : strcmp(mode, "headline") == 0 ? stateLabel(state_) : statusMessage_;
        display.drawString(value, textX, y + height / 2);
    }
    else if (type == "usage_bar" || type == "usage_text") {
        String bind = widget["bind"] | "";
        String alias = bind.substring(bind.lastIndexOf('.') + 1);
        String label = props["label"] | alias;
        renderUsage(x, y, width, height, label, quotaForAlias(alias), style);
    }
    display.clearClipRect();
}

void AgentlingApp::renderFace(int x, int y, int width, int height) {
    renderedAsset_ = "";
    renderError_ = "procedural fallback";
    if (hasPack_) {
        JsonObjectConst visual = pack_["visuals"][expression_].as<JsonObjectConst>();
        const char* renderer = visual["renderer"] | "face";
        renderVisualAtmosphere(x, y, width, height, visual);
        // `| nullptr` selects ArduinoJson's nullptr_t overload and always
        // returns null, even when the JSON contains a valid asset string.
        const char* asset = visual["asset"].as<const char*>();
        if (strcmp(renderer, "png_sequence") == 0) {
            JsonArrayConst frames = visual["frames"].as<JsonArrayConst>();
            if (!frames.isNull() && frames.size()) {
                asset = frames[visualFrameIndex_ % frames.size()].as<const char*>();
            }
        }
        renderError_ = String("renderer=") + renderer + ";asset=" + (asset ? asset : "null");
        if ((strcmp(renderer, "png") == 0 || strcmp(renderer, "png_sequence") == 0) && asset && asset[0] != '\0') {
            String path = String("/agentling/") + asset;
            int scaledWidth = max(1, width * visualScalePermille_ / 1000);
            int scaledHeight = max(1, height * visualScalePermille_ / 1000);
            int drawX = x + visualOffsetX_ - (scaledWidth - width) / 2;
            int drawY = y + visualOffsetY_ - (scaledHeight - height) / 2;
            // M5GFX treats maxWidth/maxHeight as clipping bounds unless the
            // scale arguments are zero. Fit the PNG inside the widget and use
            // middle_center so hardware matches CSS object-fit: contain.
            bool rendered = packStore_.usesSdCard()
                ? SD.exists(path) && renderTarget().drawPngFile(
                    SD, path.c_str(), drawX, drawY, scaledWidth, scaledHeight,
                    0, 0, 0.0f, 0.0f, datum_t::middle_center)
                : LittleFS.exists(path) && renderTarget().drawPngFile(
                    LittleFS, path.c_str(), drawX, drawY, scaledWidth, scaledHeight,
                    0, 0, 0.0f, 0.0f, datum_t::middle_center);
            if (rendered) {
                renderedAsset_ = asset;
                renderError_ = "";
                return;
            }
            renderError_ = String("PNG missing or decode failed: ") + asset;
        }
    }
    LovyanGFX& display = renderTarget();
    uint16_t white = display.color565(238, 247, 255);
    uint16_t pink = display.color565(241, 99, 132);
    bool closed = expression_ == "sleeping" || expression_ == "resting" || expression_ == "blink";
    bool unhappy = state_ == "failed" || expression_ == "worried" || expression_ == "concerned";
    int eyeY = y + height * 42 / 100;
    int eyeRadius = max(5, min(width, height) / 11);
    if (closed) {
        display.drawLine(x + width / 4 - eyeRadius, eyeY, x + width / 4 + eyeRadius, eyeY, white);
        display.drawLine(x + width * 3 / 4 - eyeRadius, eyeY, x + width * 3 / 4 + eyeRadius, eyeY, white);
    } else {
        display.fillCircle(x + width / 4, eyeY, eyeRadius, white);
        display.fillCircle(x + width * 3 / 4, eyeY, eyeRadius, white);
    }
    int mouthY = y + height * 70 / 100;
    if (unhappy) display.drawArc(x + width / 2, mouthY + 10, width / 10, width / 10 - 3, 200, 340, white);
    else display.drawArc(x + width / 2, mouthY, width / 10, width / 10 - 3, 20, 160, white);
    display.fillEllipse(x + width / 5, mouthY, width / 18, height / 30, pink);
    display.fillEllipse(x + width * 4 / 5, mouthY, width / 18, height / 30, pink);
}

void AgentlingApp::renderVisualAtmosphere(int x, int y, int width, int height, JsonObjectConst visual) {
    const char* animation = visual["animation"] | "none";
    uint32_t accent = parseColor(visual["accent"] | "#63E6BE", 0x63e6be);
    LovyanGFX& display = renderTarget();
    uint16_t color = display.color565(accent >> 16, accent >> 8, accent);
    uint32_t elapsed = millis() - visualStartedAt_;
    float phase = static_cast<float>(elapsed % 3200) / 3200.0f;
    int radius = max(10, min(width, height) / 2 - 8);
    int centerX = x + width / 2;
    int centerY = y + height / 2;

    if (strcmp(animation, "ambient") == 0 || strcmp(animation, "sleep") == 0 ||
        strcmp(animation, "breathe") == 0 || strcmp(animation, "breathe_slow") == 0) {
        int pulse = static_cast<int>(roundf((0.5f - 0.5f * cosf(phase * 2.0f * PI)) * 3.0f));
        display.drawCircle(centerX, centerY + 4, radius + pulse, color);
        return;
    }
    if (strcmp(animation, "focus") == 0 || strcmp(animation, "ponder") == 0 ||
        strcmp(animation, "search") == 0 || strcmp(animation, "work") == 0 ||
        strcmp(animation, "float") == 0) {
        for (int index = 0; index < 3; ++index) {
            float angle = phase * 2.0f * PI + index * 2.0f * PI / 3.0f;
            int dotX = centerX + static_cast<int>(roundf(cosf(angle) * width * 0.43f));
            int dotY = centerY + static_cast<int>(roundf(sinf(angle) * height * 0.37f));
            display.fillCircle(dotX, dotY, index == 0 ? 3 : 2, color);
        }
        return;
    }
    if (strcmp(animation, "attention") == 0 || strcmp(animation, "alert") == 0) {
        int inset = 4 + static_cast<int>(roundf((0.5f - 0.5f * cosf(phase * 4.0f * PI)) * 3.0f));
        display.drawRoundRect(x + inset, y + inset, width - inset * 2, height - inset * 2, 16, color);
        return;
    }
    if (strcmp(animation, "success") == 0 || strcmp(animation, "celebrate") == 0) {
        const int sparkleX[3] = {x + 12, x + width - 15, x + width - 30};
        const int sparkleY[3] = {y + 28, y + 50, y + height - 18};
        int arm = 3 + static_cast<int>((elapsed / 160) % 3);
        for (int index = 0; index < 3; ++index) {
            display.drawFastHLine(sparkleX[index] - arm, sparkleY[index], arm * 2 + 1, color);
            display.drawFastVLine(sparkleX[index], sparkleY[index] - arm, arm * 2 + 1, color);
        }
        return;
    }
    if (strcmp(animation, "error") == 0 || strcmp(animation, "shake") == 0) {
        int inset = 6 + static_cast<int>((elapsed / 160) % 3);
        display.drawRoundRect(x + inset, y + inset, width - inset * 2, height - inset * 2, 14, color);
    }
}

void AgentlingApp::renderUsage(int x, int y, int width, int height, const String& label, const QuotaValue& quota, JsonObjectConst style) {
    uint32_t normal = parseColor(style["normal"] | "#59D185", 0x59d185);
    uint32_t low = parseColor(style["low"] | "#FFB020", 0xffb020);
    uint32_t critical = parseColor(style["critical"] | "#FF4D4F", 0xff4d4f);
    float value = quota.remaining;
    uint32_t color = value < 0 ? 0x586174 : value <= 10 ? critical : value <= 30 ? low : normal;
    LovyanGFX& display = renderTarget();
    display.setTextDatum(top_left);
    display.drawString(label, x, y);
    display.setTextDatum(top_right);
    display.drawString(value < 0 ? "--" : String(static_cast<int>(round(value))) + "%", x + width, y);
    int barY = y + height - 5;
    display.fillRoundRect(x, barY, width, 4, 2, display.color565(38, 49, 66));
    if (value >= 0) display.fillRoundRect(x, barY, static_cast<int>(width * value / 100.0f), 4, 2, display.color565(color >> 16, color >> 8, color));
}

void AgentlingApp::renderFallback() {
    renderFace(28, 32, 264, 150);
    renderTarget().setTextColor(TFT_WHITE, 0x0841);
    renderTarget().setFont(&fonts::efontCN_16);
    renderTarget().setTextDatum(middle_center);
    renderTarget().drawString(overlayText_.isEmpty() ? stateLabel(state_) : overlayText_, 160, 202);
    renderUsage(8, 218, 145, 18, "5H", quotaForAlias("five_hour"), JsonObjectConst());
    renderUsage(167, 218, 145, 18, "7D", quotaForAlias("weekly"), JsonObjectConst());
}

QuotaValue AgentlingApp::quotaForAlias(const String& alias) const {
    String id = alias == "five_hour" ? fiveHourId_ : alias == "weekly" ? weeklyId_ : "";
    for (size_t index = 0; index < quotaCount_; ++index) if (quotas_[index].id == id) return quotas_[index];
    return {};
}

void AgentlingApp::startBehavior(const String& name) {
    if (!hasPack_ || pack_["behaviors"][name].isNull()) return;
    JsonObjectConst behavior = pack_["behaviors"][name].as<JsonObjectConst>();
    uint32_t cooldown = behavior["cooldownMs"] | 0;
    if (name == lastBehaviorName_ && millis() - lastBehaviorStartedAt_ < cooldown) return;
    behaviorName_ = name;
    behaviorStep_ = 0;
    behaviorStartedAt_ = millis();
    lastBehaviorName_ = name;
    lastBehaviorStartedAt_ = behaviorStartedAt_;
}

void AgentlingApp::updateBehavior() {
    if (behaviorName_.isEmpty() || !hasPack_) return;
    JsonObjectConst behavior = pack_["behaviors"][behaviorName_].as<JsonObjectConst>();
    JsonArrayConst steps = behavior["steps"].as<JsonArrayConst>();
    uint32_t elapsed = millis() - behaviorStartedAt_;
    while (behaviorStep_ < steps.size()) {
        JsonObjectConst step = steps[behaviorStep_];
        uint32_t at = step["at"] | 0;
        if (elapsed < at) break;
        applyBehaviorStep(step);
        ++behaviorStep_;
    }
    if (behaviorStep_ >= steps.size()) {
        bool loop = behavior["loop"] | false;
        uint32_t lastAt = steps.size() ? (steps[steps.size() - 1]["at"] | 0) : 0;
        if (loop && elapsed >= lastAt + 500) {
            behaviorStep_ = 0;
            behaviorStartedAt_ = millis();
        } else if (!loop && elapsed >= lastAt + 850) {
            // Let the final cue frame remain visible briefly, then return to
            // the latest aggregate state rather than the event's old state.
            behaviorName_ = "";
            restoreStateBehavior();
        }
    }
}

void AgentlingApp::restoreStateBehavior() {
    if (!overlayActive_) {
        if (!overlayText_.isEmpty()) {
            overlayText_ = "";
            renderDirty_ = true;
        }
        setExpression(expressionForState());
    }
    if (!hasPack_) return;
    const char* event = nullptr;
    if (state_ == "working") event = "turn.started";
    else if (state_ == "idle") event = "session.idle";
    else if (state_ == "waiting_approval") event = "approval.requested";
    else if (state_ == "needs_input") event = "input.requested";
    else if (state_ == "offline") event = "session.closed";
    if (!event) return;
    const char* name = pack_["events"][event] | nullptr;
    if (!name && state_ == "needs_input") name = pack_["events"]["approval.requested"] | nullptr;
    if (!name) return;
    JsonObjectConst behavior = pack_["behaviors"][name].as<JsonObjectConst>();
    if (behavior.isNull()) return;
    // Restart looping baseline behaviors. A one-shot baseline contributes
    // its light only; replaying it here would create an endless cue cycle.
    if (behavior["loop"] | false) {
        lastBehaviorName_ = "";
        startBehavior(name);
    } else {
        JsonArrayConst steps = behavior["steps"].as<JsonArrayConst>();
        if (steps.size() && steps[0]["light"].is<const char*>()) {
            applyLight(steps[0]["light"].as<const char*>());
        }
    }
}

void AgentlingApp::applyBehaviorStep(JsonObjectConst step) {
    if (!overlayActive_ && step["expression"].is<const char*>()) setExpression(step["expression"].as<const char*>());
    if (!overlayActive_ && step["text"].is<const char*>()) overlayText_ = step["text"].as<const char*>();
    if (step["motion"].is<const char*>()) applyMotion(step["motion"].as<const char*>());
    if (step["sound"].is<const char*>()) applySound(step["sound"].as<const char*>());
    if (step["light"].is<const char*>()) applyLight(step["light"].as<const char*>());
    renderDirty_ = true;
}

void AgentlingApp::setExpression(const String& name) {
    if (name.isEmpty() || expression_ == name) return;
    expression_ = name;
    visualFrameIndex_ = 0;
    visualStartedAt_ = millis();
    visualOffsetX_ = 0;
    visualOffsetY_ = 0;
    visualScalePermille_ = 1000;
    visualPhaseStep_ = 0;
    renderDirty_ = true;
}

void AgentlingApp::applyMotion(const String& name) {
    // Pack-driven autonomous motion remains disabled. Only the bounded direct
    // MCP command below may temporarily power the servos.
    (void)name;
}

void AgentlingApp::applySound(const String& name) {
    JsonObjectConst sound = pack_["sounds"][name].as<JsonObjectConst>();
    if (sound.isNull()) return;
    float volume = constrain(sound["volume"] | 0.3f, 0.0f, 1.0f);
    playSoundPreset(name, static_cast<uint8_t>(round(volume * 100.0f)), 8000);
}

bool AgentlingApp::playSoundPreset(const String& name, uint8_t volumePercent, uint32_t maxDurationMs) {
    JsonObjectConst sound = pack_["sounds"][name].as<JsonObjectConst>();
    if (sound.isNull()) return false;
    melodyCount_ = 0;
    melodyIndex_ = 0;
    if (sound["notes"].is<JsonArrayConst>()) {
        for (JsonVariantConst note : sound["notes"].as<JsonArrayConst>()) {
            if (melodyCount_ >= melodyNotes_.size()) break;
            melodyNotes_[melodyCount_++] = static_cast<uint16_t>(constrain(note.as<int>(), 0, 4000));
        }
    } else {
        int frequency = constrain(sound["frequency"] | 0, 0, 4000);
        if (frequency > 0) melodyNotes_[melodyCount_++] = static_cast<uint16_t>(frequency);
    }
    melodyNoteMs_ = static_cast<uint16_t>(constrain(sound["durationMs"] | (sound["noteMs"] | 90), 20, 1000));
    M5.Speaker.setVolume(static_cast<uint8_t>(round(constrain(volumePercent, 0, 50) * 255.0f / 100.0f)));
    soundStopAt_ = millis() + constrain(maxDurationMs, 100UL, 8000UL);
    melodyNextAt_ = millis();
    updateSound();
    return melodyCount_ > 0;
}

void AgentlingApp::updateSound() {
    if (soundStopAt_ && static_cast<int32_t>(millis() - soundStopAt_) >= 0) {
        melodyIndex_ = melodyCount_;
        soundStopAt_ = 0;
        M5.Speaker.stop();
        return;
    }
    if (melodyIndex_ >= melodyCount_ || static_cast<int32_t>(millis() - melodyNextAt_) < 0) return;
    uint16_t note = melodyNotes_[melodyIndex_++];
    uint32_t remaining = soundStopAt_ ? soundStopAt_ - millis() : melodyNoteMs_;
    uint16_t duration = static_cast<uint16_t>(std::min<uint32_t>(melodyNoteMs_, remaining));
    if (note > 0 && duration > 0) M5.Speaker.tone(note, duration);
    melodyNextAt_ = millis() + melodyNoteMs_ + 18;
}

void AgentlingApp::applyLight(const String& name) {
    JsonObjectConst light = pack_["lights"][name].as<JsonObjectConst>();
    if (light.isNull()) return;
    lightOverrideActive_ = false;
    lightColor_ = parseColor(light["color"] | "#000000", 0);
    lightBrightness_ = static_cast<uint8_t>(constrain(light["brightness"] | 50, 0, 100));
    lightMode_ = light["mode"] | "solid";
    lightPeriodMs_ = static_cast<uint32_t>(constrain(light["periodMs"] | 1000, 200, 10000));
    lightStartedAt_ = millis();
    lastLightUpdateAt_ = 0;
    updateLight();
}

void AgentlingApp::setDirectLight(uint32_t color, uint8_t brightness, const String& mode,
                                  uint32_t periodMs, uint32_t ttlMs) {
    if (!lightOverrideActive_) {
        savedLightMode_ = lightMode_;
        savedLightColor_ = lightColor_;
        savedLightBrightness_ = lightBrightness_;
        savedLightPeriodMs_ = lightPeriodMs_;
    }
    lightOverrideActive_ = true;
    lightOverrideDeadline_ = millis() + ttlMs;
    lightColor_ = color;
    lightBrightness_ = brightness;
    lightMode_ = mode;
    lightPeriodMs_ = periodMs;
    lightStartedAt_ = millis();
    lastLightUpdateAt_ = 0;
    updateLight();
}

bool AgentlingApp::updatePowerButton() {
    if (shuttingDown_) return true;
    if (!M5.BtnPWR.wasHold()) return false;

    // The CoreS3 PMIC turns off the main unit, but the StackChan body's RGB
    // controller can retain its last frame. Clear external outputs before the
    // main controller loses power so shutdown looks and behaves atomically.
    shuttingDown_ = true;
    lightOverrideActive_ = false;
    lightBrightness_ = 0;
    lastLightUpdateAt_ = 0;
    M5StackChan.showRgbColor(0, 0, 0);
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(false);
    servoPowerEnabled_ = false;
    M5.Speaker.stop();
    M5.Display.setBrightness(0);
    delay(50);
    M5.Power.powerOff();
    return true;
}

void AgentlingApp::updateLight() {
    uint32_t now = millis();
    if (lightOverrideActive_ && static_cast<int32_t>(now - lightOverrideDeadline_) >= 0) {
        lightOverrideActive_ = false;
        lightMode_ = savedLightMode_;
        lightColor_ = savedLightColor_;
        lightBrightness_ = savedLightBrightness_;
        lightPeriodMs_ = savedLightPeriodMs_;
        lightStartedAt_ = now;
        lastLightUpdateAt_ = 0;
    }
    if (lightMode_ == "solid" && lastLightUpdateAt_) return;
    if (lastLightUpdateAt_ && now - lastLightUpdateAt_ < 50) return;
    lastLightUpdateAt_ = now;
    float phase = lightPeriodMs_
        ? static_cast<float>((now - lightStartedAt_) % lightPeriodMs_) / lightPeriodMs_
        : 0.0f;
    float level = 1.0f;
    if (lightMode_ == "breathe") {
        level = 0.2f + 0.8f * (0.5f - 0.5f * cosf(phase * 2.0f * PI));
    } else if (lightMode_ == "pulse") {
        level = 0.25f + 0.75f * (0.5f - 0.5f * cosf(phase * 2.0f * PI));
    }
    uint8_t red = static_cast<uint8_t>(((lightColor_ >> 16) & 0xff) * lightBrightness_ * level / 100.0f);
    uint8_t green = static_cast<uint8_t>(((lightColor_ >> 8) & 0xff) * lightBrightness_ * level / 100.0f);
    uint8_t blue = static_cast<uint8_t>((lightColor_ & 0xff) * lightBrightness_ * level / 100.0f);
    int activePair = static_cast<int>(phase * 6.0f) % 6;
    for (int index = 0; index < 6; ++index) {
        float pairLevel = lightMode_ == "chase" && index != activePair ? 0.12f : 1.0f;
        uint8_t pairRed = static_cast<uint8_t>(red * pairLevel);
        uint8_t pairGreen = static_cast<uint8_t>(green * pairLevel);
        uint8_t pairBlue = static_cast<uint8_t>(blue * pairLevel);
        // 0..5 and 6..11 are left/right. Pair first, then issue one shared
        // refresh so both sides always advance in the same phase.
        M5StackChan.setRgbColor(index, pairRed, pairGreen, pairBlue);
        M5StackChan.setRgbColor(index + 6, pairRed, pairGreen, pairBlue);
    }
    M5StackChan.refreshRgb();
}

void AgentlingApp::updateServoMotion() {
    if (servoPhase_ == 0) return;
    if (*M5StackChan.Motion.safetyError()) {
        finishServoMotion(false, M5StackChan.Motion.safetyError());
        return;
    }
    const uint32_t now = millis();
    if (static_cast<int32_t>(now - servoDeadline_) >= 0) {
        finishServoMotion(false, "servo movement timeout");
        return;
    }
    if (servoLastStepAt_ && now - servoLastStepAt_ < 100) return;
    servoLastStepAt_ = now;
    const auto actual = M5StackChan.Motion.getCurrentAngles();
    if (actual.x == INVALID_SERVO_ANGLE || actual.y == INVALID_SERVO_ANGLE) {
        finishServoMotion(false, "position feedback lost");
        return;
    }
    servoYawTenths_ = actual.x;
    servoPitchTenths_ = actual.y;
    // Match the official completion semantics. Small position errors remain
    // possible; return the measured endpoint rather than repeatedly chasing it.
    if (M5StackChan.Motion.isMoving()) {
        servoPhase_ = 1;
        return;
    }
    if (servoPhase_ == 1) {
        servoPhase_ = 2;
        servoNextAt_ = now + servoHoldMs_;
    } else if (static_cast<int32_t>(now - servoNextAt_) >= 0) {
        // Release at the destination, never enqueue an automatic home.
        finishServoMotion(true);
    }
}

void AgentlingApp::finishServoMotion(bool ok, const char* error) {
    const String requestId = servoRequestId_;
    const char* command = "servo";
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(false);
    M5StackChan.Motion.setAutoTorqueReleaseEnabled(true);
    servoPowerEnabled_ = false;
    servoPhase_ = 0;
    servoTargetYawTenths_ = 0;
    servoTargetPitchTenths_ = 0;
    servoLastStepAt_ = 0;
    servoNextAt_ = 0;
    servoDeadline_ = 0;
    servoRequestId_ = "";
    lastServoCompletedAt_ = millis();
    sendHardwareResult(requestId, command, ok, error);
    servoYawTenths_ = INVALID_SERVO_ANGLE;
    servoPitchTenths_ = INVALID_SERVO_ANGLE;
}

void AgentlingApp::updateVisual() {
    if (!hasPack_ || millis() - lastVisualUpdateAt_ < 80) return;
    lastVisualUpdateAt_ = millis();
    JsonObjectConst visual = pack_["visuals"][expression_].as<JsonObjectConst>();
    if (visual.isNull()) return;
    size_t nextFrame = 0;
    JsonArrayConst frames = visual["frames"].as<JsonArrayConst>();
    if (!frames.isNull() && frames.size()) {
        uint32_t frameMs = static_cast<uint32_t>(constrain(visual["frameMs"] | 1000, 120, 10000));
        nextFrame = ((millis() - visualStartedAt_) / frameMs) % frames.size();
    }
    const char* animation = visual["animation"] | "none";
    uint32_t elapsed = millis() - visualStartedAt_;
    int nextX = 0;
    int nextY = 0;
    int nextScale = 1000;
    float wave = sinf(elapsed * 2.0f * PI / 3200.0f);
    if (strcmp(animation, "ambient") == 0) {
        nextY = static_cast<int>(roundf(wave * 2.0f));
        nextScale = 1004 + static_cast<int>(roundf(wave * 4.0f));
    } else if (strcmp(animation, "sleep") == 0) {
        nextY = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 4800.0f)));
        nextScale = 1002 + static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 4800.0f) * 2.0f));
    } else if (strcmp(animation, "focus") == 0) {
        nextX = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 1900.0f)));
        nextY = static_cast<int>(roundf(cosf(elapsed * 2.0f * PI / 1900.0f)));
        nextScale = 1002 + static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 1900.0f) * 2.0f));
    } else if (strcmp(animation, "ponder") == 0 || strcmp(animation, "search") == 0) {
        nextX = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 2700.0f) * 2.0f));
        nextY = static_cast<int>(roundf(cosf(elapsed * 2.0f * PI / 2700.0f) * 2.0f));
    } else if (strcmp(animation, "attention") == 0) {
        nextScale = 1005 + static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 1200.0f) * 7.0f));
    } else if (strcmp(animation, "success") == 0) {
        if (elapsed < 1350) {
            float progress = static_cast<float>(elapsed) / 1350.0f;
            nextY = -static_cast<int>(roundf(fabsf(sinf(progress * 2.0f * PI)) * (1.0f - progress) * 8.0f));
            nextScale = 1000 + static_cast<int>(roundf(sinf(progress * PI) * 24.0f));
        }
    } else if (strcmp(animation, "error") == 0) {
        if (elapsed < 1000) {
            float decay = 1.0f - static_cast<float>(elapsed) / 1000.0f;
            nextX = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 160.0f) * decay * 4.0f));
        }
    } else if (strcmp(animation, "breathe") == 0) nextY = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 2800.0f) * 2.0f));
    else if (strcmp(animation, "breathe_slow") == 0) nextY = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 4200.0f) * 2.0f));
    else if (strcmp(animation, "float") == 0) nextY = static_cast<int>(roundf(sinf(elapsed * 2.0f * PI / 1800.0f) * 3.0f));
    else if (strcmp(animation, "work") == 0) nextY = (elapsed / 180) % 2 ? -2 : 0;
    else if (strcmp(animation, "alert") == 0) nextY = (elapsed / 300) % 2 ? -2 : 0;
    else if (strcmp(animation, "celebrate") == 0) nextY = (elapsed / 160) % 2 ? -4 : 0;
    else if (strcmp(animation, "shake") == 0) nextX = static_cast<int>((elapsed / 120) % 3) - 1;
    uint16_t nextPhaseStep = strcmp(animation, "none") == 0 ? 0 : static_cast<uint16_t>((elapsed / 160) % 20000);
    if (nextFrame != visualFrameIndex_ || nextX != visualOffsetX_ || nextY != visualOffsetY_ ||
        nextScale != visualScalePermille_ || nextPhaseStep != visualPhaseStep_) {
        visualFrameIndex_ = nextFrame;
        visualOffsetX_ = nextX;
        visualOffsetY_ = nextY;
        visualScalePermille_ = nextScale;
        visualPhaseStep_ = nextPhaseStep;
        renderDirty_ = true;
    }
}

void AgentlingApp::updateTouch() {
    auto detail = M5.Touch.getDetail();
    if (detail.wasPressed()) {
        touchDown_ = true;
        touchStartX_ = detail.x;
        touchStartY_ = detail.y;
    } else if (touchDown_ && detail.wasReleased()) {
        touchDown_ = false;
        if (cameraConsentPending_) {
            if (touchStartY_ >= 160 && touchStartX_ < 160) {
                const String requestId = cameraRequestId_;
                sendCameraResult(requestId, false, "user rejected camera capture");
                finishCameraConsent();
            } else if (touchStartY_ >= 160 && touchStartX_ >= 160) {
                const String requestId = cameraRequestId_;
                cameraConsentPending_ = false;
                cameraCapturing_ = true;
                renderDirty_ = true;
                render();
                captureCamera(requestId);
                finishCameraConsent();
            }
            return;
        }
        int dx = detail.x - touchStartX_;
        if (dx > 40) sendInput("swipe_right");
        else if (dx < -40) sendInput("swipe_left");
        else if (touchStartY_ > 185) sendInput("task_next");
        else sendInput("tap");
    }
}

void AgentlingApp::updateHeadTouch() {
    auto& touch = M5StackChan.TouchSensor;
    if (touch.wasClicked()) sendInput("head_touch", "head");
    if (touch.wasSwipedForward()) sendInput("head_swipe_forward", "head");
    if (touch.wasSwipedBackward()) sendInput("head_swipe_backward", "head");
}

void AgentlingApp::updatePhysicalSensors() {
    if (millis() - lastPhysicalSensorAt_ < 50) return;
    lastPhysicalSensorAt_ = millis();
    if (!M5.Imu.isEnabled() || !M5.Imu.update()) return;
    const auto imu = M5.Imu.getImuData();
    const float magnitude = sqrtf(imu.accel.x * imu.accel.x + imu.accel.y * imu.accel.y + imu.accel.z * imu.accel.z);
    if (magnitude > 2.2f && millis() - lastShakeAt_ > 2000) {
        lastShakeAt_ = millis();
        sendInput("shake", "imu");
    }
}

void AgentlingApp::updateCameraConsent() {
    if (!cameraConsentPending_) return;
    if (static_cast<int32_t>(millis() - cameraConsentDeadline_) < 0) return;
    const String requestId = cameraRequestId_;
    sendCameraResult(requestId, false, "camera confirmation timed out");
    finishCameraConsent();
}

void AgentlingApp::updateIdle() {
    if (state_ != "idle" || behaviorName_.length()) return;
    uint32_t idleFor = millis() - idleStartedAt_;
    if (idleFor > 180'000 && millis() - lastIdleEventAt_ > 30'000) {
        lastIdleEventAt_ = millis();
        setExpression("blink");
        statusMessage_ = idleFor > 600'000 ? "休息一下，额度也在慢慢恢复" : "等待新任务";
        renderDirty_ = true;
    }
}

uint32_t AgentlingApp::parseColor(const char* value, uint32_t fallback) {
    if (!value || value[0] != '#' || strlen(value) != 7) return fallback;
    return strtoul(value + 1, nullptr, 16);
}

String AgentlingApp::stateLabel(const String& state) {
    if (state == "working") return "正在工作";
    if (state == "waiting_approval") return "等待批准";
    if (state == "needs_input") return "需要输入";
    if (state == "completed") return "任务完成";
    if (state == "failed") return "任务失败";
    if (state == "offline") return "桌面端离线";
    return "空闲中";
}

}  // namespace agentling
