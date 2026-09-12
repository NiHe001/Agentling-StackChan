#include "AgentlingApp.h"

#include <cmath>
#include <cstring>

namespace agentling {

namespace {

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
    M5StackChan.Motion.setAutoTorqueReleaseEnabled(true);
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
    protocol_.poll(Serial, [this](const EnvelopeView& envelope) {
        handleEnvelope(envelope);
        protocol_.send(Serial, "ack", [&envelope](CborWriter& writer) {
            writer.map(1);
            writer.key("sequence"); writer.unsignedInteger(envelope.sequence);
        });
    });
    updateBehavior();
    updateTouch();
    updateIdle();
    if (torqueReleaseAt_ && static_cast<int32_t>(millis() - torqueReleaseAt_) >= 0) {
        M5StackChan.Motion.setTorqueEnabled(false);
        torqueReleaseAt_ = 0;
    }
    if (hostOnline_ && millis() - lastHostMessageAt_ > 15'000) {
        hostOnline_ = false;
        state_ = "offline";
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
        parseAgentSnapshot(payload);
        renderDirty_ = true;
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
}

void AgentlingApp::parseAgentSnapshot(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    taskCount_ = 0;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "tasks") {
            size_t count;
            if (!reader.readArraySize(count)) return;
            for (size_t taskIndex = 0; taskIndex < count; ++taskIndex) {
                size_t taskFields;
                if (!reader.readMapSize(taskFields)) return;
                TaskValue task;
                for (size_t field = 0; field < taskFields; ++field) {
                    String taskKey;
                    if (!reader.readText(taskKey)) return;
                    if (taskKey == "id") reader.readText(task.id);
                    else if (taskKey == "title") reader.readText(task.title);
                    else if (!reader.skipValue()) return;
                }
                if (taskCount_ < tasks_.size()) tasks_[taskCount_++] = task;
            }
        } else if (key == "activeTaskId") activeTaskId_ = readTextOrEmpty(reader);
        else if (key == "aggregateState") reader.readText(state_);
        else if (!reader.skipValue()) return;
    }
    activeTaskTitle_ = "";
    for (size_t index = 0; index < taskCount_; ++index) {
        if (tasks_[index].id == activeTaskId_) activeTaskTitle_ = tasks_[index].title;
    }
    statusMessage_ = activeTaskTitle_.isEmpty() ? stateLabel(state_) : activeTaskTitle_;
    if (state_ == "idle") {
        if (!idleStartedAt_) idleStartedAt_ = millis();
    } else idleStartedAt_ = 0;
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
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return;
        if (key == "behavior") behavior = readTextOrEmpty(reader);
        else if (key == "overlay") {
            overlaySeen = true;
            if (reader.peekMajor() == 7 && reader.readNull()) {
                overlayText_ = "";
            } else {
                size_t overlayFields;
                if (!reader.readMapSize(overlayFields)) return;
                for (size_t field = 0; field < overlayFields; ++field) {
                    String overlayKey;
                    reader.readText(overlayKey);
                    if (overlayKey == "scene") reader.readText(expression_);
                    else if (overlayKey == "text") overlayText_ = readTextOrEmpty(reader);
                    else reader.skipValue();
                }
            }
        } else if (!reader.skipValue()) return;
    }
    if (!behavior.isEmpty()) startBehavior(behavior);
    if (overlaySeen && overlayText_.isEmpty() && state_ == "idle") expression_ = "resting";
}

void AgentlingApp::parsePackManifest(CborReader& reader) {
    size_t fields;
    if (!reader.readMapSize(fields)) return;
    String id, version;
    std::vector<ExpectedFile> files;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        reader.readText(key);
        if (key == "id") reader.readText(id);
        else if (key == "version") reader.readText(version);
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
    if (!packStore_.beginTransaction(id, version, files)) sendError(packStore_.error());
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
}

void AgentlingApp::sendHello() {
    protocol_.send(Serial, "device.hello", [](CborWriter& writer) {
        writer.map(3);
        writer.key("firmwareVersion"); writer.text("0.1.0");
        writer.key("protocolVersion"); writer.unsignedInteger(AGENTLING_PROTOCOL_VERSION);
        writer.key("capabilities");
        writer.map(5);
        writer.key("display"); writer.map(3);
        writer.key("width"); writer.unsignedInteger(320);
        writer.key("height"); writer.unsignedInteger(240);
        writer.key("touch"); writer.boolean(true);
        writer.key("servo"); writer.map(2);
        writer.key("yaw"); writer.boolean(true);
        writer.key("pitch"); writer.boolean(true);
        writer.key("speaker"); writer.boolean(true);
        writer.key("rgbCount"); writer.unsignedInteger(12);
        writer.key("sdCard"); writer.boolean(true);
    });
}

void AgentlingApp::sendInput(const char* type) {
    protocol_.send(Serial, "input.event", [type](CborWriter& writer) {
        writer.map(2);
        writer.key("type"); writer.text(type);
        writer.key("at"); writer.unsignedInteger(millis());
    });
}

void AgentlingApp::sendError(const String& message) {
    protocol_.send(Serial, "error", [&message](CborWriter& writer) {
        writer.map(1);
        writer.key("message"); writer.text(message);
    });
}

LovyanGFX& AgentlingApp::renderTarget() {
    if (canvasReady_) return canvas_;
    return M5.Display;
}

String AgentlingApp::sceneForState() const {
    if (state_ == "failed" || state_ == "waiting_approval" || state_ == "offline") return "critical";
    if (state_ == "needs_input") return "waiting";
    if (state_ == "working") return "working";
    if (state_ == "idle") return "idle";
    return "base";
}

void AgentlingApp::render() {
    lastRenderAt_ = millis();
    renderDirty_ = false;
    LovyanGFX& display = renderTarget();
    display.startWrite();
    display.fillScreen(0x0841);
    if (hasPack_) renderConfigured();
    else renderFallback();
    if (!hostOnline_) {
        display.fillRoundRect(226, 5, 86, 18, 4, 0x5000);
        display.setTextColor(TFT_WHITE, 0x5000);
        display.setTextDatum(middle_center);
        display.drawString("DESKTOP OFFLINE", 269, 14);
    }
    display.endWrite();
    if (canvasReady_) canvas_.pushSprite(0, 0);
}

void AgentlingApp::renderConfigured() {
    JsonObjectConst layouts = pack_["ui"]["layouts"].as<JsonObjectConst>();
    JsonObjectConst scene = layouts[sceneForState()].as<JsonObjectConst>();
    if (scene.isNull()) scene = layouts["base"].as<JsonObjectConst>();
    for (JsonObjectConst widget : scene["widgets"].as<JsonArrayConst>()) {
        renderWidget(widget, JsonObjectConst());
    }
    if (sceneForState() == "critical") {
        uint32_t color = state_ == "waiting_approval" ? 0xffb020 : 0xff4d4f;
        renderTarget().drawRoundRect(18, 50, 284, 132, 16, renderTarget().color565(color >> 16, color >> 8, color));
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
    display.setTextColor(display.color565(fg >> 16, fg >> 8, fg), display.color565(bg >> 16, bg >> 8, bg));
    display.setTextSize(fontSize >= 16 ? 2 : 1);
    display.setTextDatum(middle_left);
    String type = widget["widget"] | "";
    if (type == "sprite") renderFace(x, y, width, height);
    else if (type == "clock") display.drawString(localTime_, x + 3, y + height / 2);
    else if (type == "weather") {
        String value = isnan(temperatureC_) ? "天气 --" : String(static_cast<int>(round(temperatureC_))) + "° " + weatherLabel_;
        display.drawString(value, x + 3, y + height / 2);
    } else if (type == "agent_badge") display.drawString("CODEX", x + 3, y + height / 2);
    else if (type == "task_count") display.drawString(String(taskCount_) + " TASKS", x + 3, y + height / 2);
    else if (type == "status_text") display.drawString(overlayText_.isEmpty() ? statusMessage_ : overlayText_, x + 4, y + height / 2);
    else if (type == "usage_bar" || type == "usage_text") {
        String bind = widget["bind"] | "";
        String alias = bind.substring(bind.lastIndexOf('.') + 1);
        JsonObjectConst props = widget["props"].as<JsonObjectConst>();
        String label = props["label"] | alias;
        renderUsage(x, y, width, height, label, quotaForAlias(alias), style);
    }
}

void AgentlingApp::renderFace(int x, int y, int width, int height) {
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
        } else if (!loop) behaviorName_ = "";
    }
}

void AgentlingApp::applyBehaviorStep(JsonObjectConst step) {
    if (step["expression"].is<const char*>()) expression_ = step["expression"].as<const char*>();
    if (step["text"].is<const char*>()) overlayText_ = step["text"].as<const char*>();
    if (step["motion"].is<const char*>()) applyMotion(step["motion"].as<const char*>());
    if (step["sound"].is<const char*>()) applySound(step["sound"].as<const char*>());
    if (step["light"].is<const char*>()) applyLight(step["light"].as<const char*>());
    renderDirty_ = true;
}

void AgentlingApp::applyMotion(const String& name) {
    JsonObjectConst motion = pack_["motions"][name].as<JsonObjectConst>();
    if (motion.isNull()) return;
    int yaw = constrain(motion["yaw"] | 0, -900, 900);
    int pitch = constrain(motion["pitch"] | 0, -450, 450);
    int speed = constrain(motion["speed"] | 350, 1, 1000);
    M5StackChan.setServoPowerEnabled(true);
    M5StackChan.Motion.setTorqueEnabled(true);
    M5StackChan.Motion.move(yaw, pitch, speed);
    bool release = motion["releaseTorque"] | false;
    uint32_t hold = static_cast<uint32_t>(constrain(motion["holdMs"] | 500, 0, 30000));
    // A hard three-second ceiling prevents a malformed pack from holding torque forever.
    torqueReleaseAt_ = millis() + (release ? min<uint32_t>(hold, 3000) : 3000);
}

void AgentlingApp::applySound(const String& name) {
    JsonObjectConst sound = pack_["sounds"][name].as<JsonObjectConst>();
    if (sound.isNull()) return;
    int frequency = sound["frequency"] | 0;
    if (!frequency && sound["notes"].is<JsonArrayConst>()) frequency = sound["notes"][0] | 0;
    int duration = sound["durationMs"] | 0;
    if (!duration) duration = sound["noteMs"] | 90;
    if (frequency > 0) M5.Speaker.tone(frequency, duration);
}

void AgentlingApp::applyLight(const String& name) {
    JsonObjectConst light = pack_["lights"][name].as<JsonObjectConst>();
    if (light.isNull()) return;
    uint32_t color = parseColor(light["color"] | "#000000", 0);
    int brightness = constrain(light["brightness"] | 50, 0, 100);
    uint8_t red = static_cast<uint8_t>(((color >> 16) & 0xff) * brightness / 100);
    uint8_t green = static_cast<uint8_t>(((color >> 8) & 0xff) * brightness / 100);
    uint8_t blue = static_cast<uint8_t>((color & 0xff) * brightness / 100);
    M5StackChan.showRgbColor(red, green, blue);
}

void AgentlingApp::updateTouch() {
    auto detail = M5.Touch.getDetail();
    if (detail.wasPressed()) {
        touchDown_ = true;
        touchStartX_ = detail.x;
        touchStartY_ = detail.y;
    } else if (touchDown_ && detail.wasReleased()) {
        touchDown_ = false;
        int dx = detail.x - touchStartX_;
        if (dx > 40) sendInput("swipe_right");
        else if (dx < -40) sendInput("swipe_left");
        else if (touchStartY_ > 185) sendInput("task_next");
        else sendInput("tap");
    }
}

void AgentlingApp::updateIdle() {
    if (state_ != "idle" || behaviorName_.length()) return;
    uint32_t idleFor = millis() - idleStartedAt_;
    if (idleFor > 180'000 && millis() - lastIdleEventAt_ > 30'000) {
        lastIdleEventAt_ = millis();
        expression_ = "blink";
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
