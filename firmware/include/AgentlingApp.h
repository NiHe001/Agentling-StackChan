#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <M5StackChan.h>
#include <array>

#include "PackStore.h"
#include "Protocol.h"

namespace agentling {

struct QuotaValue {
    String id;
    float remaining{-1};
    uint64_t resetsAt{0};
    bool stale{true};
};

struct TaskValue {
    String id;
    String title;
};

class AgentlingApp {
public:
    void begin();
    void update();

private:
    void handleEnvelope(const EnvelopeView& envelope);
    void parseAgentSnapshot(CborReader& reader);
    void parseWidgetSnapshot(CborReader& reader);
    void parseUsage(CborReader& reader);
    void parseClock(CborReader& reader);
    void parseWeather(CborReader& reader);
    void parseActionCue(CborReader& reader);
    void parsePackManifest(CborReader& reader);
    void parsePackChunk(CborReader& reader);
    void parsePackCommit(CborReader& reader);

    void sendHello();
    void sendInput(const char* type);
    void sendError(const String& message);
    LovyanGFX& renderTarget();
    void render();
    void renderFallback();
    void renderConfigured();
    void renderWidget(JsonObjectConst widget, JsonObjectConst overrideValue);
    void renderFace(int x, int y, int width, int height);
    void renderUsage(int x, int y, int width, int height, const String& label, const QuotaValue& quota, JsonObjectConst style);

    void startBehavior(const String& name);
    void updateBehavior();
    void applyBehaviorStep(JsonObjectConst step);
    void applyMotion(const String& name);
    void applySound(const String& name);
    void applyLight(const String& name);
    void updateTouch();
    void updateIdle();
    String sceneForState() const;
    QuotaValue quotaForAlias(const String& alias) const;

    static uint32_t parseColor(const char* value, uint32_t fallback);
    static String stateLabel(const String& state);

    FrameProtocol protocol_;
    PackStore packStore_;
    M5Canvas canvas_{&M5.Display};
    JsonDocument pack_;
    bool canvasReady_{false};
    bool renderDirty_{true};
    bool hasPack_{false};
    bool hostOnline_{false};
    String state_{"idle"};
    String activeTaskId_;
    String activeTaskTitle_;
    String statusMessage_;
    String expression_{"resting"};
    String overlayText_;
    String localTime_{"--:--"};
    String weatherLabel_{"--"};
    float temperatureC_{NAN};
    std::array<TaskValue, 8> tasks_{};
    size_t taskCount_{0};
    std::array<QuotaValue, 8> quotas_{};
    size_t quotaCount_{0};
    String fiveHourId_;
    String weeklyId_;

    String behaviorName_;
    size_t behaviorStep_{0};
    uint32_t behaviorStartedAt_{0};
    uint32_t torqueReleaseAt_{0};
    uint32_t lastHostMessageAt_{0};
    uint32_t hostEpoch_{0};
    uint32_t lastHostSequence_{0};
    uint32_t lastRenderAt_{0};
    uint32_t idleStartedAt_{0};
    uint32_t lastIdleEventAt_{0};
    bool touchDown_{false};
    int touchStartX_{0};
    int touchStartY_{0};
    String lastBehaviorName_;
    uint32_t lastBehaviorStartedAt_{0};
};

}  // namespace agentling
