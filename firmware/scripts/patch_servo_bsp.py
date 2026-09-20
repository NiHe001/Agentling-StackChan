"""Rebuild the small adapter patch from pinned upstream, never compound edits.

Only generated PlatformIO dependency files are written. The independent
servo-baseline environment intentionally does not run this script.
"""
from pathlib import Path
import subprocess

Import("env")
repo = Path(env.subst("$PROJECT_LIBDEPS_DIR")) / env.subst("$PIOENV") / "StackChan-BSP"
revision = "f7ed40e6f5d9a1d08440cb926f3a0865b81882f8"
actual = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
if actual != revision:
    raise RuntimeError("Unexpected StackChan-BSP revision; adapter patch refused")

def original(relative):
    return subprocess.check_output(
        ["git", "-C", str(repo), "show", revision + ":src/" + relative]
    ).decode("utf-8-sig").replace("\r\n", "\n")

def write(relative, text):
    path = repo / "src" / relative
    if path.read_text(encoding="utf-8-sig") != text:
        path.write_text(text, encoding="utf-8")

def replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError("Unexpected upstream source; adapter patch refused: " + old)
    return text.replace(old, new)

text = original("M5StackChan.cpp")
start = text.index("class ScsServo :")
end = text.index("void M5StackChan_Class::servo_init()", start)
text = text[:start] + '#include "AgentlingScsServo.inc"\n\n' + text[end:]
text = replace(text, "setServoPowerEnabled(true);",
               "setServoPowerEnabled(false); // Agentling: no boot movement")
write("M5StackChan.cpp", text)

text = original("utils/motion/servo.h")
text = replace(text, "    virtual void init();", """    virtual void init();
    virtual bool prepareSafe() { return false; }
    virtual bool prepareRecovery() { return false; }
    virtual const char* safetyError() const { return "unsupported servo"; }""")
write("utils/motion/servo.h", text)

text = original("utils/motion/motion.h")
text = '#include <string>\n' + text
text = replace(text, "    bool isMoving();", """    bool prepareSafe();
    bool enablePreparedTorque();
    std::string inspectServos();
    const char* safetyError();
    bool isMoving();""")
write("utils/motion/motion.h", text)

text = original("utils/motion/motion.cpp")
text = replace(text, "bool Motion::isMoving()", """bool Motion::prepareSafe()
{
    std::lock_guard<std::mutex> lock(_mutex);
    _yaw_servo->setTorqueEnabled(false);
    _pitch_servo->setTorqueEnabled(false);
    if (!_yaw_servo->prepareSafe() || !_pitch_servo->prepareSafe()) {
        _yaw_servo->setTorqueEnabled(false);
        _pitch_servo->setTorqueEnabled(false);
        return false;
    }
    return true;
}
bool Motion::enablePreparedTorque()
{
    std::lock_guard<std::mutex> lock(_mutex);
    _yaw_servo->setTorqueEnabled(true);
    _pitch_servo->setTorqueEnabled(true);
    if (_yaw_servo->getTorqueEnabled() && _pitch_servo->getTorqueEnabled()) return true;
    _yaw_servo->setTorqueEnabled(false);
    _pitch_servo->setTorqueEnabled(false);
    return false;
}
std::string Motion::inspectServos()
{
    std::lock_guard<std::mutex> lock(_mutex);
    _yaw_servo->prepareRecovery();
    std::string report = _yaw_servo->safetyError();
    _pitch_servo->prepareRecovery();
    return report + "; " + _pitch_servo->safetyError();
}
const char* Motion::safetyError()
{
    std::lock_guard<std::mutex> lock(_mutex);
    const char* yaw = _yaw_servo->safetyError();
    return *yaw ? yaw : _pitch_servo->safetyError();
}
bool Motion::isMoving()""")
write("utils/motion/motion.cpp", text)

# Preserve upstream animation and speed mapping, but never feed a failed read
# (INT_MIN) into its starting position or clamp it into an endpoint.
text = original("utils/motion/servo.cpp")
text = replace(text, "    angle = uitk_intl::clamp(angle, _angle_limit.x, _angle_limit.y);",
               "    if (angle < _angle_limit.x || angle > _angle_limit.y) { setTorqueEnabled(false); return; }")
text = replace(text, "        _angle_anim.teleport(getCurrentAngle());  // Use current angle as start",
               """        const int actual = getCurrentAngle();
        if (actual < _angle_limit.x || actual > _angle_limit.y) { setTorqueEnabled(false); return; }
        _angle_anim.teleport(actual);""")
write("utils/motion/servo.cpp", text)

text = original("drivers/FTServo_Arduino/src/SCSCL.h")
needle = "int ReadPos(int ID);"
text = replace(text, needle, """int ReadPos(int ID);
        struct PositionResult { bool ok; int raw; unsigned char communicationError; unsigned char deviceStatus; };
        PositionResult ReadPosChecked(int ID) {
            if (ID < 0 || ID >= 254) return {false, -1, 255, 0};
            const int raw = ReadPos(ID);
            return {raw >= 0 && getLastError() == 0 && getState() == 0,
                    raw, getLastError(), getState()};
        }""")
write("drivers/FTServo_Arduino/src/SCSCL.h", text)
