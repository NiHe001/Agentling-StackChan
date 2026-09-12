#include "PackStore.h"

#include <FS.h>
#include <LittleFS.h>
#include <mbedtls/sha256.h>
#include <algorithm>

namespace agentling {

static constexpr const char* ACTIVE_ROOT = "/agentling";
static constexpr const char* STAGING_ROOT = "/agentling.staging";
static constexpr const char* BACKUP_ROOT = "/agentling.previous";

bool PackStore::begin() {
    available_ = LittleFS.begin(true);
    if (!available_) error_ = "LittleFS mount failed; using built-in rescue UI";
    return available_;
}

bool PackStore::beginTransaction(
    const String& id,
    const String& version,
    const std::vector<ExpectedFile>& files
) {
    if (!available_) return false;
    if (files.empty() || files.size() > 128) {
        error_ = "invalid pack file count";
        return false;
    }
    size_t total = 0;
    for (const auto& file : files) {
        if (!safePath(file.path) || file.size > 2 * 1024 * 1024) {
            error_ = "unsafe or oversized pack file";
            return false;
        }
        total += file.size;
    }
    const size_t capacity = LittleFS.totalBytes();
    const size_t reserve = std::min<size_t>(capacity, 64 * 1024);
    if (total > capacity - reserve) {
        error_ = "pack exceeds available LittleFS space";
        return false;
    }
    if (!removeTree(STAGING_ROOT)) {
        error_ = "cannot clear staging directory";
        return false;
    }
    if (!LittleFS.mkdir(STAGING_ROOT)) {
        error_ = "cannot create staging directory";
        return false;
    }
    transactionId_ = id;
    transactionVersion_ = version;
    expectedFiles_ = files;
    error_ = "";
    return true;
}

bool PackStore::writeChunk(
    const String& relativePath,
    size_t offset,
    const std::vector<uint8_t>& data
) {
    if (!available_ || transactionId_.isEmpty() || !safePath(relativePath)) return false;
    auto found = std::find_if(expectedFiles_.begin(), expectedFiles_.end(), [&](const ExpectedFile& file) {
        return file.path == relativePath;
    });
    if (found == expectedFiles_.end() || offset + data.size() > found->size) {
        error_ = "unexpected pack chunk";
        return false;
    }
    String path = String(STAGING_ROOT) + "/" + relativePath;
    if (!ensureParentDirectories(path)) return false;
    // FILE_WRITE is "w" on Arduino-ESP32 and truncates an existing file.
    // Create/truncate only the first chunk; later chunks must preserve data.
    File file = LittleFS.open(path, offset == 0 ? FILE_WRITE : "r+");
    if (!file || !file.seek(offset)) {
        error_ = "cannot open or seek pack file";
        return false;
    }
    size_t written = file.write(data.data(), data.size());
    file.close();
    if (written != data.size()) {
        error_ = "short write while syncing pack";
        return false;
    }
    return true;
}

bool PackStore::commit(const String& id, const String& version) {
    if (id != transactionId_ || version != transactionVersion_) {
        error_ = "pack commit does not match transaction";
        return false;
    }
    for (const auto& expected : expectedFiles_) {
        if (!verifyFile(expected)) return false;
    }
    if (!removeTree(BACKUP_ROOT)) {
        error_ = "cannot clear previous rollback copy";
        return false;
    }
    if (LittleFS.exists(ACTIVE_ROOT) && !LittleFS.rename(ACTIVE_ROOT, BACKUP_ROOT)) {
        error_ = "cannot create pack rollback copy";
        return false;
    }
    if (!LittleFS.rename(STAGING_ROOT, ACTIVE_ROOT)) {
        if (LittleFS.exists(BACKUP_ROOT)) LittleFS.rename(BACKUP_ROOT, ACTIVE_ROOT);
        error_ = "cannot activate pack; previous pack restored";
        return false;
    }
    transactionId_ = "";
    transactionVersion_ = "";
    expectedFiles_.clear();
    error_ = "";
    return true;
}

bool PackStore::loadRuntime(JsonDocument& target) {
    if (!available_) return false;
    File file = LittleFS.open(String(ACTIVE_ROOT) + "/pack.runtime.json", FILE_READ);
    if (!file) return false;
    DeserializationError result = deserializeJson(target, file);
    file.close();
    if (result) {
        error_ = String("invalid pack.runtime.json: ") + result.c_str();
        target.clear();
        return false;
    }
    return true;
}

bool PackStore::safePath(const String& path) const {
    return !path.isEmpty() && !path.startsWith("/") && path.indexOf("..") < 0 && path.indexOf('\\') < 0;
}

bool PackStore::ensureParentDirectories(const String& path) {
    int cursor = 1;
    while ((cursor = path.indexOf('/', cursor)) >= 0) {
        String directory = path.substring(0, cursor);
        if (!LittleFS.exists(directory) && !LittleFS.mkdir(directory)) {
            error_ = "cannot create pack directory";
            return false;
        }
        cursor += 1;
    }
    return true;
}

bool PackStore::verifyFile(const ExpectedFile& expected) {
    String path = String(STAGING_ROOT) + "/" + expected.path;
    File file = LittleFS.open(path, FILE_READ);
    if (!file || static_cast<size_t>(file.size()) != expected.size) {
        error_ = String("missing or incomplete file: ") + expected.path;
        if (file) file.close();
        return false;
    }
    mbedtls_sha256_context context;
    mbedtls_sha256_init(&context);
    mbedtls_sha256_starts(&context, 0);
    uint8_t buffer[1024];
    while (file.available()) {
        size_t count = file.read(buffer, sizeof(buffer));
        mbedtls_sha256_update(&context, buffer, count);
    }
    file.close();
    uint8_t digest[32];
    mbedtls_sha256_finish(&context, digest);
    mbedtls_sha256_free(&context);
    char hex[65];
    for (size_t index = 0; index < 32; ++index) sprintf(hex + index * 2, "%02x", digest[index]);
    hex[64] = '\0';
    if (!expected.sha256.equalsIgnoreCase(hex)) {
        error_ = String("checksum mismatch: ") + expected.path;
        return false;
    }
    return true;
}

bool PackStore::removeTree(const String& path) {
    if (!LittleFS.exists(path)) return true;
    File root = LittleFS.open(path);
    if (!root) return false;
    if (!root.isDirectory()) {
        root.close();
        return LittleFS.remove(path);
    }
    bool success = true;
    File entry;
    while ((entry = root.openNextFile())) {
        String child = entry.path();
        bool directory = entry.isDirectory();
        entry.close();
        if (directory) success = removeTree(child) && success;
        else success = LittleFS.remove(child) && success;
    }
    root.close();
    return LittleFS.rmdir(path) && success;
}

}  // namespace agentling
