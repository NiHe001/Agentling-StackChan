#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FS.h>
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
    bool beginTransaction(const String& id, const String& version, const String& digest, const std::vector<ExpectedFile>& files);
    bool writeChunk(const String& relativePath, size_t offset, const std::vector<uint8_t>& data);
    bool commit(const String& id, const String& version);
    bool activateCached(const String& id, const String& version, const String& digest);
    bool loadRuntime(JsonDocument& target);
    const String& activeDigest() const { return activeDigest_; }
    const String& error() const { return error_; }
    bool available() const { return available_; }
    bool sdAvailable() const { return sdAvailable_; }
    bool usesSdCard() const { return activeStorageName_ == "microSD"; }
    const String& storageName() const { return activeStorageName_; }
    uint64_t totalBytes() const;
    uint64_t usedBytes() const;
    fs::FS& filesystem();

private:
    bool safePath(const String& path) const;
    bool ensureParentDirectories(fs::FS& storage, const String& path);
    bool verifyFile(fs::FS& storage, const ExpectedFile& expected);
    bool removeTree(fs::FS& storage, const String& path);
    bool validDigest(const String& digest) const;
    String readDigest(fs::FS& storage, const String& root) const;
    bool writeDigest(fs::FS& storage, const String& root, const String& digest);
    void closeTransactionFile();

    bool available_{false};
    bool littleFsAvailable_{false};
    bool sdAvailable_{false};
    fs::FS* activeStorage_{nullptr};
    fs::FS* transactionStorage_{nullptr};
    File transactionFile_;
    String transactionFilePath_;
    size_t transactionFileOffset_{0};
    String activeStorageName_{"none"};
    String transactionId_;
    String transactionVersion_;
    String transactionDigest_;
    String activeDigest_;
    String error_;
    std::vector<ExpectedFile> expectedFiles_;
};

}  // namespace agentling
