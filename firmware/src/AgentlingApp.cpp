#include "AgentlingApp.h"

#include <LittleFS.h>
#include <SD.h>
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
    // This release keeps the head still: the BSP enables the servo rail while
    // booting, so disable both torque and power immediately after begin().
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(false);
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
    updateSound();
    updateLight();
    updateVisual();
    updateTouch();
    updateIdle();
    if (hostOnline_ && millis() - lastHostMessageAt_ > 15'000) {
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
                    if (overlayKey == "scene") {
                        String scene;
                        reader.readText(scene);
                        setExpression(scene);
                    }
                    else if (overlayKey == "text") overlayText_ = readTextOrEmpty(reader);
                    else reader.skipValue();
                }
            }
        } else if (!reader.skipValue()) return;
    }
    if (!behavior.isEmpty()) startBehavior(behavior);
    if (overlaySeen && overlayText_.isEmpty()) setExpression(expressionForState());
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
    if (!hasPack_) sendError(packStore_.error());
}

void AgentlingApp::sendHello() {
    protocol_.send(Serial, "device.hello", [this](CborWriter& writer) {
        writer.map(4);
        writer.key("diagnostics"); writer.map(22);
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
        writer.key("firmwareVersion"); writer.text("0.4.1");
        writer.key("protocolVersion"); writer.unsignedInteger(AGENTLING_PROTOCOL_VERSION);
        writer.key("capabilities");
        writer.map(5);
        writer.key("display"); writer.map(3);
        writer.key("width"); writer.unsignedInteger(320);
        writer.key("height"); writer.unsignedInteger(240);
        writer.key("touch"); writer.boolean(true);
        writer.key("servo"); writer.map(2);
        writer.key("yaw"); writer.boolean(false);
        writer.key("pitch"); writer.boolean(false);
        writer.key("speaker"); writer.boolean(true);
        writer.key("rgbCount"); writer.unsignedInteger(12);
        writer.key("sdCard"); writer.boolean(packStore_.sdAvailable());
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
        } else if (!loop) behaviorName_ = "";
    }
}

void AgentlingApp::applyBehaviorStep(JsonObjectConst step) {
    if (step["expression"].is<const char*>()) setExpression(step["expression"].as<const char*>());
    if (step["text"].is<const char*>()) overlayText_ = step["text"].as<const char*>();
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
    // Deliberate no-op for firmware 0.2.x. Keep the method and pack field so a
    // later opt-in motion release does not require a protocol change.
    (void)name;
    M5StackChan.Motion.setTorqueEnabled(false);
    M5StackChan.setServoPowerEnabled(false);
}

void AgentlingApp::applySound(const String& name) {
    JsonObjectConst sound = pack_["sounds"][name].as<JsonObjectConst>();
    if (sound.isNull()) return;
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
    float volume = constrain(sound["volume"] | 0.3f, 0.0f, 1.0f);
    M5.Speaker.setVolume(static_cast<uint8_t>(round(volume * 255.0f)));
    melodyNextAt_ = millis();
    updateSound();
}

void AgentlingApp::updateSound() {
    if (melodyIndex_ >= melodyCount_ || static_cast<int32_t>(millis() - melodyNextAt_) < 0) return;
    uint16_t note = melodyNotes_[melodyIndex_++];
    if (note > 0) M5.Speaker.tone(note, melodyNoteMs_);
    melodyNextAt_ = millis() + melodyNoteMs_ + 18;
}

void AgentlingApp::applyLight(const String& name) {
    JsonObjectConst light = pack_["lights"][name].as<JsonObjectConst>();
    if (light.isNull()) return;
    lightColor_ = parseColor(light["color"] | "#000000", 0);
    lightBrightness_ = static_cast<uint8_t>(constrain(light["brightness"] | 50, 0, 100));
    lightMode_ = light["mode"] | "solid";
    lightPeriodMs_ = static_cast<uint32_t>(constrain(light["periodMs"] | 1000, 200, 10000));
    lightStartedAt_ = millis();
    lastLightUpdateAt_ = 0;
    updateLight();
}

void AgentlingApp::updateLight() {
    uint32_t now = millis();
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
