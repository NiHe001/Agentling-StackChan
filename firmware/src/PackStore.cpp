#include "PackStore.h"

#include <FS.h>
#include <LittleFS.h>
#include <SD.h>
#include <SPI.h>
#include <mbedtls/sha256.h>
#include <algorithm>

namespace agentling {

static constexpr const char* ACTIVE_ROOT = "/agentling";
static constexpr const char* STAGING_ROOT = "/agentling.staging";
static constexpr const char* BACKUP_ROOT = "/agentling.previous";

bool PackStore::begin() {
    littleFsAvailable_ = LittleFS.begin(true);
    // CoreS3 exposes its TF slot on the board SPI bus with CS on GPIO4. Use
    // the card when present, while retaining LittleFS as a no-card fallback.
    sdAvailable_ = SD.begin(GPIO_NUM_4, SPI, 25'000'000) && SD.cardType() != CARD_NONE;
    if (sdAvailable_ && SD.exists(String(ACTIVE_ROOT) + "/pack.runtime.json")) {
        activeStorage_ = &SD;
        activeStorageName_ = "microSD";
    } else if (littleFsAvailable_ && LittleFS.exists(String(ACTIVE_ROOT) + "/pack.runtime.json")) {
        activeStorage_ = &LittleFS;
        activeStorageName_ = "LittleFS";
    } else if (sdAvailable_) {
        activeStorage_ = &SD;
        activeStorageName_ = "microSD";
    } else if (littleFsAvailable_) {
        activeStorage_ = &LittleFS;
        activeStorageName_ = "LittleFS";
    }
    available_ = activeStorage_ != nullptr;
    if (!available_) error_ = "microSD and LittleFS mount failed; using built-in rescue UI";
    return available_;
}

bool PackStore::beginTransaction(
    const String& id,
    const String& version,
    const std::vector<ExpectedFile>& files
) {
    if (!available_) return false;
    closeTransactionFile();
    transactionStorage_ = sdAvailable_ ? static_cast<fs::FS*>(&SD) : activeStorage_;
    if (!transactionStorage_) return false;
    if (files.empty() || files.size() > 128) {
        error_ = "invalid pack file count";
        return false;
    }
    size_t total = 0;
    for (const auto& file : files) {
        if (!safePath(file.path) || file.size > 8 * 1024 * 1024) {
            error_ = "unsafe or oversized pack file";
            return false;
        }
        total += file.size;
    }
    const uint64_t capacity = transactionStorage_ == static_cast<fs::FS*>(&SD)
        ? SD.totalBytes() : LittleFS.totalBytes();
    const uint64_t reserve = std::min<uint64_t>(capacity, 64 * 1024);
    if (total > capacity - reserve) {
        error_ = "pack exceeds available storage capacity";
        return false;
    }
    if (!removeTree(*transactionStorage_, STAGING_ROOT)) {
        error_ = "cannot clear staging directory";
        return false;
    }
    if (!transactionStorage_->mkdir(STAGING_ROOT)) {
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
    if (!available_ || !transactionStorage_ || transactionId_.isEmpty() || !safePath(relativePath)) return false;
    auto found = std::find_if(expectedFiles_.begin(), expectedFiles_.end(), [&](const ExpectedFile& file) {
        return file.path == relativePath;
    });
    if (found == expectedFiles_.end() || offset + data.size() > found->size) {
        error_ = "unexpected pack chunk";
        return false;
    }
    String path = String(STAGING_ROOT) + "/" + relativePath;
    if (transactionFilePath_ != path) {
        closeTransactionFile();
        if (offset != 0 || !ensureParentDirectories(*transactionStorage_, path)) {
            error_ = "pack file did not start at offset zero";
            return false;
        }
        transactionFile_ = transactionStorage_->open(path, FILE_WRITE);
        if (!transactionFile_) {
            error_ = "cannot open pack file";
            return false;
        }
        transactionFilePath_ = path;
        transactionFileOffset_ = 0;
    }
    // A host retry can repeat a fully written chunk after its ACK was lost.
    if (offset < transactionFileOffset_ && offset + data.size() <= transactionFileOffset_) return true;
    if (offset != transactionFileOffset_) {
        error_ = "non-sequential pack chunk";
        return false;
    }
    size_t written = transactionFile_.write(data.data(), data.size());
    if (written != data.size()) {
        error_ = "short write while syncing pack";
        return false;
    }
    transactionFileOffset_ += written;
    return true;
}

bool PackStore::commit(const String& id, const String& version) {
    closeTransactionFile();
    if (id != transactionId_ || version != transactionVersion_) {
        error_ = "pack commit does not match transaction";
        return false;
    }
    if (!transactionStorage_) return false;
    fs::FS& storage = *transactionStorage_;
    for (const auto& expected : expectedFiles_) {
        if (!verifyFile(storage, expected)) return false;
    }
    if (!removeTree(storage, BACKUP_ROOT)) {
        error_ = "cannot clear previous rollback copy";
        return false;
    }
    if (storage.exists(ACTIVE_ROOT) && !storage.rename(ACTIVE_ROOT, BACKUP_ROOT)) {
        error_ = "cannot create pack rollback copy";
        return false;
    }
    if (!storage.rename(STAGING_ROOT, ACTIVE_ROOT)) {
        if (storage.exists(BACKUP_ROOT)) storage.rename(BACKUP_ROOT, ACTIVE_ROOT);
        error_ = "cannot activate pack; previous pack restored";
        return false;
    }
    transactionId_ = "";
    transactionVersion_ = "";
    expectedFiles_.clear();
    activeStorage_ = transactionStorage_;
    activeStorageName_ = activeStorage_ == static_cast<fs::FS*>(&SD) ? "microSD" : "LittleFS";
    transactionStorage_ = nullptr;
    error_ = "";
    return true;
}

void PackStore::closeTransactionFile() {
    if (transactionFile_) {
        transactionFile_.flush();
        transactionFile_.close();
    }
    transactionFilePath_ = "";
    transactionFileOffset_ = 0;
}

bool PackStore::loadRuntime(JsonDocument& target) {
    if (!available_ || !activeStorage_) return false;
    File file = activeStorage_->open(String(ACTIVE_ROOT) + "/pack.runtime.json", FILE_READ);
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

bool PackStore::ensureParentDirectories(fs::FS& storage, const String& path) {
    int cursor = 1;
    while ((cursor = path.indexOf('/', cursor)) >= 0) {
        String directory = path.substring(0, cursor);
        if (!storage.exists(directory) && !storage.mkdir(directory)) {
            error_ = "cannot create pack directory";
            return false;
        }
        cursor += 1;
    }
    return true;
}

bool PackStore::verifyFile(fs::FS& storage, const ExpectedFile& expected) {
    String path = String(STAGING_ROOT) + "/" + expected.path;
    File file = storage.open(path, FILE_READ);
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

bool PackStore::removeTree(fs::FS& storage, const String& path) {
    if (!storage.exists(path)) return true;
    File root = storage.open(path);
    if (!root) return false;
    if (!root.isDirectory()) {
        root.close();
        return storage.remove(path);
    }
    bool success = true;
    File entry;
    while ((entry = root.openNextFile())) {
        String child = entry.path();
        bool directory = entry.isDirectory();
        entry.close();
        if (directory) success = removeTree(storage, child) && success;
        else success = storage.remove(child) && success;
    }
    root.close();
    return storage.rmdir(path) && success;
}

uint64_t PackStore::totalBytes() const {
    if (activeStorage_ == static_cast<const fs::FS*>(&SD)) return SD.totalBytes();
    return littleFsAvailable_ ? LittleFS.totalBytes() : 0;
}

uint64_t PackStore::usedBytes() const {
    if (activeStorage_ == static_cast<const fs::FS*>(&SD)) return SD.usedBytes();
    return littleFsAvailable_ ? LittleFS.usedBytes() : 0;
}

fs::FS& PackStore::filesystem() {
    return activeStorage_ ? *activeStorage_ : static_cast<fs::FS&>(LittleFS);
}

}  // namespace agentling
