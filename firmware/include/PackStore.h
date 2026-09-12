#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <vector>

namespace agentling {

struct ExpectedFile {
    String path;
    size_t size{0};
    String sha256;
};

class PackStore {
public:
    bool begin();
    bool beginTransaction(const String& id, const String& version, const std::vector<ExpectedFile>& files);
    bool writeChunk(const String& relativePath, size_t offset, const std::vector<uint8_t>& data);
    bool commit(const String& id, const String& version);
    bool loadRuntime(JsonDocument& target);
    const String& error() const { return error_; }
    bool available() const { return available_; }

private:
    bool safePath(const String& path) const;
    bool ensureParentDirectories(const String& path);
    bool verifyFile(const ExpectedFile& expected);
    bool removeTree(const String& path);

    bool available_{false};
    String transactionId_;
    String transactionVersion_;
    String error_;
    std::vector<ExpectedFile> expectedFiles_;
};

}  // namespace agentling
