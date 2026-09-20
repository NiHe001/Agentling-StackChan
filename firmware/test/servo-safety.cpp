#include <cassert>
#include <string>
#include <vector>
#include "ServoFeedback.h"
struct Vec { int x, y; };
struct ServoConfig_t { int id=1; int defaultZeroPos=460; Vec rawPosLimit{0,1000}; Vec angleLimit{-1280,1280}; std::string settingNs, settingZeroPositionKey; };
namespace stackchan::motion {
class Servo {
protected:
    struct Animation { void teleport(int) {} } _angle_anim;
    bool _snap_to_target_on_rest=false;
    void set_angle_limit(Vec) {}
    void apply_default_spring_options() {}
    virtual void set_angle_impl(int)=0;
    virtual bool is_moving_impl() { return false; }
public:
    virtual void init() {} virtual void update() {} virtual bool prepareSafe() { return false; }
    virtual bool prepareRecovery() { return false; } virtual int stepHome() { return -1; }
    virtual const char* safetyError() const { return ""; }
    virtual int getCurrentAngle() { return 0; }
    virtual void setTorqueEnabled(bool) {} virtual bool getTorqueEnabled() { return false; }
    virtual void rotate(int) {} virtual void setCurrentAngleAsZero() {}
};
}
int calibration=460;
struct Settings { Settings(std::string,bool) {} int GetInt(std::string,int fallback) { return calibration < 0 ? fallback : calibration; } };
void delay(int) {}
enum { SCSCL_MIN_ANGLE_LIMIT_L, SCSCL_MAX_ANGLE_LIMIT_L, SCSCL_GOAL_POSITION_L, SCSCL_TORQUE_ENABLE, SCSCL_CW_DEAD, SCSCL_CCW_DEAD };
struct MockBus {
    struct Result { bool ok; int raw; unsigned char communicationError=0, deviceStatus=0; };
    std::vector<int> positions;
    unsigned cursor=0;
    int raw=460, goal=460, enabled=0, writes=0, enables=0;
    bool writeFailure=false, readbackFailure=false, torqueFailure=false;
    Result ReadPosChecked(int) {
        int value=cursor < positions.size() ? positions[cursor++] : raw;
        return {value>=0,value};
    }
    int EnableTorque(int,int value) { if (!torqueFailure) enabled=value; enables+=value; return torqueFailure ? 0 : 1; }
    int readByte(int,int) { return torqueFailure ? -1 : enabled; }
    int readWord(int,int reg) {
        if (reg==SCSCL_MIN_ANGLE_LIMIT_L) return 0;
        if (reg==SCSCL_MAX_ANGLE_LIMIT_L) return 1000;
        return readbackFailure ? -1 : goal;
    }
    int Ping(int id) { return id; }
    int ReadMove(int) { return 0; }
    int WritePos(int,int value,int time,int speed) { assert(time==20 && speed==0); ++writes; if (!writeFailure) goal=value; return writeFailure ? 0 : 1; }
    int getState() { return 0; }
    int getLastError() { return torqueFailure ? 1 : 0; }
} _scs_bus;
struct Power { bool on=true; void setServoPowerEnabled(bool value) { on=value; } } M5StackChan;
#include "AgentlingScsServo.inc"
class TestServo : public ScsServo { public: using ScsServo::ScsServo; using ScsServo::set_angle_impl; };
void reset() { _scs_bus=MockBus{}; M5StackChan.on=true; calibration=460; }
int main() {
    using namespace agentling;
    assert(decodeServoPosition(-1,460,-1280,1280).error==ServoReadError::Communication);
    assert(decodeServoPosition(1024,460,-1280,1280).error==ServoReadError::RawRange);
    assert(decodeServoPosition(460,460,-1280,1280).angle==0);
    reset(); _scs_bus.raw=-1;
    TestServo failed(ServoConfig_t{}); failed.init();
    assert(!_scs_bus.writes && !_scs_bus.enables);
    assert(!failed.prepareSafe() && !_scs_bus.writes && !M5StackChan.on);
    reset(); _scs_bus.raw=748; // off-center is not interpreted as home
    TestServo offset(ServoConfig_t{}); offset.init();
    assert(offset.prepareSafe() && _scs_bus.goal==748 && !_scs_bus.enables);
    offset.setTorqueEnabled(true);
    offset.set_angle_impl(100);
    assert(_scs_bus.goal==492); // official tenth-degree conversion, not a home
    offset.setTorqueEnabled(false);
    const int writes=_scs_bus.writes;
    offset.set_angle_impl(0);
    assert(_scs_bus.writes==writes); // no writes after torque release
    reset(); calibration=-1;
    TestServo defaults(ServoConfig_t{}); defaults.init();
    assert(defaults.prepareSafe() && _scs_bus.goal==460); // official fallback
    reset(); _scs_bus.readbackFailure=true;
    TestServo readback(ServoConfig_t{}); readback.init();
    assert(!readback.prepareSafe() && !_scs_bus.enables);
    reset(); TestServo inspect(ServoConfig_t{}); inspect.init();
    assert(inspect.prepareRecovery() && !_scs_bus.writes && !_scs_bus.enables);
    reset(); TestServo lost(ServoConfig_t{}); lost.init();
    assert(lost.prepareSafe()); lost.setTorqueEnabled(true);
    _scs_bus.raw=-1;
    assert(lost.getCurrentAngle()==INVALID_SERVO_ANGLE && !M5StackChan.on);
    reset(); TestServo limits(ServoConfig_t{}); limits.init();
    assert(limits.prepareSafe()); limits.setTorqueEnabled(true);
    const int before=_scs_bus.writes;
    limits.set_angle_impl(2000);
    assert(_scs_bus.writes==before && !M5StackChan.on);
}
