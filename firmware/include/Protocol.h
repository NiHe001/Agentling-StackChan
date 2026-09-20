#pragma once

#include <Arduino.h>
#include <functional>
#include <vector>

namespace agentling {

class CborReader {
public:
    explicit CborReader(const std::vector<uint8_t>& data);
    CborReader(const uint8_t* data, size_t size);

    bool readMapSize(size_t& size);
    bool readArraySize(size_t& size);
    bool readText(String& value);
    bool readBytes(std::vector<uint8_t>& value);
    bool readUnsigned(uint64_t& value);
    bool readNumber(double& value);
    bool readBool(bool& value);
    bool readNull();
    bool skipValue();
    bool captureValue(std::vector<uint8_t>& value);
    uint8_t peekMajor() const;
    bool good() const { return ok_; }

private:
    bool readHeader(uint8_t& major, uint64_t& value);
    bool readLength(uint8_t additional, uint64_t& value);

    const uint8_t* data_;
    size_t size_;
    size_t position_{0};
    bool ok_{true};
};

class CborWriter {
public:
    void map(size_t size);
    void array(size_t size);
    void text(const String& value);
    void text(const char* value);
    void bytes(const uint8_t* value, size_t size);
    void unsignedInteger(uint64_t value);
    void number(double value);
    void boolean(bool value);
    void nullValue();
    void key(const char* value) { text(value); }
    const std::vector<uint8_t>& data() const { return data_; }

private:
    void header(uint8_t major, uint64_t value);
    std::vector<uint8_t> data_;
};

struct EnvelopeView {
    uint32_t epoch{0};
    uint32_t sequence{0};
    String type;
    std::vector<uint8_t> payload;
};

class FrameProtocol {
public:
    using Handler = std::function<void(const EnvelopeView&)>;
    using PayloadWriter = std::function<void(CborWriter&)>;

    void begin();
    void poll(Stream& stream, const Handler& handler);
    void send(Stream& stream, const String& type, const PayloadWriter& payloadWriter);
    uint32_t epoch() const { return epoch_; }

private:
    bool decodeFrame(const std::vector<uint8_t>& encoded, EnvelopeView& envelope);
    static uint32_t crc32(const uint8_t* data, size_t size);
    static bool cobsDecode(const std::vector<uint8_t>& input, std::vector<uint8_t>& output);
    static void cobsEncode(const std::vector<uint8_t>& input, std::vector<uint8_t>& output);

    std::vector<uint8_t> receiveBuffer_;
    uint32_t epoch_{0};
    uint32_t sequence_{0};
    uint32_t lastReceivedSequence_{0};
};

}  // namespace agentling
