#pragma once
#include <climits>
#include <cstdlib>

namespace agentling {
enum class ServoReadError { None, Communication, RawRange, ZeroInvalid, AngleRange, Unstable };
struct ServoReading {
    ServoReadError error;
    int raw;
    int angle;
    explicit operator bool() const { return error == ServoReadError::None; }
};
// Invalid angles must never be converted or clamped into a motion target.
constexpr int INVALID_SERVO_ANGLE = INT_MIN;
inline ServoReading decodeServoPosition(int raw, int zero, int minAngle, int maxAngle) {
    if (raw < 0) return {ServoReadError::Communication, raw, INVALID_SERVO_ANGLE};
    if (raw > 1000) return {ServoReadError::RawRange, raw, INVALID_SERVO_ANGLE};
    // Require room for the full configured travel at both ends.
    if (zero < 0 || zero > 1000 || zero + minAngle * 16 / 50 < 0 ||
        zero + maxAngle * 16 / 50 > 1000)
        return {ServoReadError::ZeroInvalid, raw, INVALID_SERVO_ANGLE};
    const int angle = (raw - zero) * 50 / 16;
    // Small mechanical/backlash tolerance at the calibrated boundary. A valid
    // raw reading is mandatory; communication failures never reach this path.
    if (angle < minAngle - 15 || angle > maxAngle + 15)
        return {ServoReadError::AngleRange, raw, INVALID_SERVO_ANGLE};
    return {ServoReadError::None, raw, angle < minAngle ? minAngle : angle > maxAngle ? maxAngle : angle};
}
class StableServoReadings {
    int count_ = 0, min_ = 0, max_ = 0;
public:
    bool add(const ServoReading& value) {
        if (!value) { count_ = 0; return false; }
        if (!count_) min_ = max_ = value.raw;
        if (value.raw < min_) min_ = value.raw;
        if (value.raw > max_) max_ = value.raw;
        if (max_ - min_ > 2) { count_ = 0; return false; }
        return ++count_ >= 5;
    }
};
}
