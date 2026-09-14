// Host regression: clang++ -std=c++17 -I firmware/.pio/libdeps/stackchan-cores3/ArduinoJson/src firmware/test/asset-path.cpp -o /tmp/agentling-asset-test
#include <ArduinoJson.h>
#include <cassert>
#include <cstring>
int main() {
    JsonDocument pack;
    assert(!deserializeJson(pack, R"({"visuals":{"idle":{"renderer":"png","asset":"assets/sprites/idle.png"}}})"));
    JsonObjectConst visual = pack["visuals"]["idle"].as<JsonObjectConst>();
    const char* asset = visual["asset"].as<const char*>();
    assert(asset && std::strcmp(asset, "assets/sprites/idle.png") == 0);
    assert(visual["missing"].as<const char*>() == nullptr);
    // Document the overload trap that caused the physical device fallback.
    const char* broken = visual["asset"] | nullptr;
    assert(broken == nullptr);
}
