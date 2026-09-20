// Adapter for StackChan-BSP 1.1.0 (MIT, M5Stack Technology).
// Keep the official spring animation, tenth-degree mapping and WritePos time.
#include "ServoFeedback.h"
class ScsServo : public stackchan::motion::Servo {
public:
    explicit ScsServo(const ServoConfig_t& config) : _config(config) {}
    void init() override {
        set_angle_limit(_config.angleLimit);
        Settings settings(_config.settingNs, false);
        _zero = settings.GetInt(_config.settingZeroPositionKey, _config.defaultZeroPos);
        if (_zero < _config.rawPosLimit.x || _zero > _config.rawPosLimit.y)
            _zero = _config.defaultZeroPos;
        // Rail is off at boot. Servo::init() would read an unpowered servo.
        apply_default_spring_options();
        _angle_anim.teleport(0);
        _snap_to_target_on_rest = false;
    }
    agentling::ServoReading readPosition() {
        const auto result = _scs_bus.ReadPosChecked(_config.id);
        return agentling::decodeServoPosition(result.ok ? result.raw : -1, _zero,
                                             _config.angleLimit.x, _config.angleLimit.y);
    }
    bool prepareSafe() override {
        _prepared = _enabled = false;
        _scs_bus.EnableTorque(_config.id, 0);
        const auto position = readPosition();
        if (!position) return fail("position unavailable; movement refused");
        _angle_anim.teleport(position.angle);
        _snap_to_target_on_rest = false;
        // Synchronize the retained target before enabling torque.
        _scs_bus.WritePos(_config.id, position.raw, 20, 0);
        if (_scs_bus.readWord(_config.id, SCSCL_GOAL_POSITION_L) != position.raw)
            return fail("initial target could not be verified");
        _prepared = true;
        _error = "";
        return true;
    }
    // Legacy inspection entry point, no target writes or motion preparation.
    bool prepareRecovery() override {
        _prepared = _enabled = false;
        _scs_bus.EnableTorque(_config.id, 0);
        const int ping = _scs_bus.Ping(_config.id);
        const int pingError = _scs_bus.getLastError();
        const auto raw = _scs_bus.ReadPosChecked(_config.id);
        const int goal = _scs_bus.readWord(_config.id, SCSCL_GOAL_POSITION_L);
        const int cwDead = _scs_bus.readByte(_config.id, SCSCL_CW_DEAD);
        const int ccwDead = _scs_bus.readByte(_config.id, SCSCL_CCW_DEAD);
        snprintf(_diagnostic, sizeof(_diagnostic),
                 "id=%d ping=%d pingError=%d raw=%d comm=%d status=%d zero=%d goal=%d dead=%d/%d writes=%u last=%d",
                 _config.id, ping, pingError, raw.raw, raw.communicationError,
                 raw.deviceStatus, _zero, goal, cwDead, ccwDead, _writes, _lastTarget);
        _error = _diagnostic;
        return raw.ok;
    }
    const char* safetyError() const override { return _error; }
    int getCurrentAngle() override {
        const auto position = readPosition();
        if (!position) { fail("position read failed"); return agentling::INVALID_SERVO_ANGLE; }
        return position.angle;
    }
    void setTorqueEnabled(bool enabled) override {
        if (enabled && !_prepared) { fail("servo not initialized from feedback"); return; }
        _scs_bus.EnableTorque(_config.id, enabled ? 1 : 0);
        _enabled = enabled;
        if (!enabled) {
            _prepared = false;
            _snap_to_target_on_rest = false;
        }
    }
    bool getTorqueEnabled() override {
        return _enabled && _scs_bus.readByte(_config.id, SCSCL_TORQUE_ENABLE) == 1;
    }
    void update() override { if (_prepared && _enabled) Servo::update(); }
    void rotate(int) override { fail("continuous rotation unsupported"); }
    void setCurrentAngleAsZero() override { fail("calibration requires physical setup"); }
protected:
    void set_angle_impl(int angle) override {
        if (!_prepared || !_enabled) return;
        if (!readPosition()) { fail("position feedback lost"); return; }
        if (angle < _config.angleLimit.x || angle > _config.angleLimit.y) {
            fail("angle outside configured range"); return;
        }
        const int raw = _zero + angle * 16 / 5 / 10;
        if (raw < _config.rawPosLimit.x || raw > _config.rawPosLimit.y) {
            fail("position outside servo range"); return;
        }
        _scs_bus.WritePos(_config.id, raw, 20, 0);
        ++_writes;
        _lastTarget = raw;
    }
    bool is_moving_impl() override {
        const int moving = _scs_bus.ReadMove(_config.id);
        if (moving < 0) { fail("movement feedback lost"); return false; }
        return moving != 0;
    }
private:
    ServoConfig_t _config;
    int _zero = -1;
    bool _prepared = false, _enabled = false;
    const char* _error = "not prepared";
    char _diagnostic[180]{};
    unsigned _writes = 0;
    int _lastTarget = -1;
    bool fail(const char* error) {
        _error = error;
        _prepared = _enabled = false;
        _snap_to_target_on_rest = false;
        _scs_bus.EnableTorque(_config.id, 0);
        M5StackChan.setServoPowerEnabled(false);
        return false;
    }
};
