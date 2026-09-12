#include "AgentlingApp.h"

agentling::AgentlingApp app;

void setup() {
    app.begin();
}

void loop() {
    app.update();
    delay(2);
}
