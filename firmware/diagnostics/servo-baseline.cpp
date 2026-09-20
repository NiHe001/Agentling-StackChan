#include <M5Unified.h>
#include <drivers/PY32IOExpander/PY32IOExpander.hpp>
#include <drivers/FTServo_Arduino/src/SCSCL.h>

// Official StackChan-BSP 1.1.0 wiring/transport. No Motion instance, position
// writes, torque-enable, calibration, or EEPROM writes. Send 'r' to repeat.
static m5::PY32IOExpander_Class io;
static SCSCL bus;
static bool ready = false;

static void inspect() {
    if (!ready) return;
    io.digitalWrite(0, true);
    delay(2000);
    for (int id = 1; id <= 2; ++id) {
        bus.EnableTorque(id, 0);
        for (int sample = 0; sample < 10; ++sample) {
            const int ping = bus.Ping(id);
            const int pingError = bus.getLastError();
            const int raw = bus.ReadPos(id);
            const int readError = bus.getLastError();
            const int status = bus.getState();
            const int torque = bus.readByte(id, SCSCL_TORQUE_ENABLE);
            Serial.printf("BASELINE id=%d sample=%d ping=%d pingError=%d raw=%d readError=%d status=%d torque=%d\n",
                          id, sample, ping, pingError, raw, readError, status, torque);
            delay(30);
        }
    }
    io.digitalWrite(0, false);
    Serial.println("BASELINE done; servo power OFF; no movement commanded");
}

void setup() {
    M5.begin();
    Serial.begin(921600);
    delay(1500);
    if (!io.begin()) { Serial.println("BASELINE IO expander unavailable"); return; }
    io.setDirection(0, true);
    io.setPullMode(0, true);
    io.digitalWrite(0, false);
    ready = bus.begin(UART_NUM_1, 1000000, 6, 7);
    Serial.printf("BASELINE official UART ready=%d\n", ready);
    inspect();
}

void loop() {
    if (Serial.available() && Serial.read() == 'r') inspect();
    delay(20);
}
