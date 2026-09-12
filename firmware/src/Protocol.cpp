#include "Protocol.h"

#include <cstring>
#include <esp_system.h>

namespace agentling {

void FrameProtocol::begin() {
    epoch_ = esp_random();
    sequence_ = 0;
    lastReceivedSequence_ = 0;
    receiveBuffer_.reserve(24 * 1024);
}

CborReader::CborReader(const std::vector<uint8_t>& data) : data_(data.data()), size_(data.size()) {}
CborReader::CborReader(const uint8_t* data, size_t size) : data_(data), size_(size) {}

uint8_t CborReader::peekMajor() const {
    return position_ < size_ ? static_cast<uint8_t>(data_[position_] >> 5) : 0xff;
}

bool CborReader::readLength(uint8_t additional, uint64_t& value) {
    if (additional < 24) {
        value = additional;
        return true;
    }
    size_t width = additional == 24 ? 1 : additional == 25 ? 2 : additional == 26 ? 4 : additional == 27 ? 8 : 0;
    if (width == 0 || position_ + width > size_) return ok_ = false;
    value = 0;
    for (size_t index = 0; index < width; ++index) value = (value << 8) | data_[position_++];
    return true;
}

bool CborReader::readHeader(uint8_t& major, uint64_t& value) {
    if (position_ >= size_) return ok_ = false;
    uint8_t initial = data_[position_++];
    major = initial >> 5;
    return readLength(initial & 0x1f, value);
}

bool CborReader::readMapSize(size_t& size) {
    uint8_t major;
    uint64_t value;
    if (!readHeader(major, value) || major != 5) return ok_ = false;
    size = static_cast<size_t>(value);
    return true;
}

bool CborReader::readArraySize(size_t& size) {
    uint8_t major;
    uint64_t value;
    if (!readHeader(major, value) || major != 4) return ok_ = false;
    size = static_cast<size_t>(value);
    return true;
}

bool CborReader::readText(String& value) {
    uint8_t major;
    uint64_t length;
    if (!readHeader(major, length) || major != 3 || position_ + length > size_) return ok_ = false;
    value = String(reinterpret_cast<const char*>(data_ + position_), static_cast<unsigned int>(length));
    position_ += length;
    return true;
}

bool CborReader::readBytes(std::vector<uint8_t>& value) {
    uint8_t major;
    uint64_t length;
    if (!readHeader(major, length) || major != 2 || position_ + length > size_) return ok_ = false;
    value.assign(data_ + position_, data_ + position_ + length);
    position_ += length;
    return true;
}

bool CborReader::readUnsigned(uint64_t& value) {
    uint8_t major;
    if (!readHeader(major, value) || major != 0) return ok_ = false;
    return true;
}

bool CborReader::readNumber(double& value) {
    if (position_ >= size_) return ok_ = false;
    uint8_t initial = data_[position_];
    uint8_t major = initial >> 5;
    if (major == 0 || major == 1) {
        uint64_t integer;
        if (!readHeader(major, integer)) return false;
        value = major == 0 ? static_cast<double>(integer) : -1.0 - static_cast<double>(integer);
        return true;
    }
    if (major != 7) return ok_ = false;
    position_++;
    uint8_t additional = initial & 0x1f;
    if (additional == 26 && position_ + 4 <= size_) {
        uint32_t bits = 0;
        for (int i = 0; i < 4; ++i) bits = (bits << 8) | data_[position_++];
        float number;
        std::memcpy(&number, &bits, sizeof(number));
        value = number;
        return true;
    }
    if (additional == 27 && position_ + 8 <= size_) {
        uint64_t bits = 0;
        for (int i = 0; i < 8; ++i) bits = (bits << 8) | data_[position_++];
        std::memcpy(&value, &bits, sizeof(value));
        return true;
    }
    return ok_ = false;
}

bool CborReader::readBool(bool& value) {
    if (position_ >= size_) return ok_ = false;
    uint8_t byte = data_[position_++];
    if (byte == 0xf4 || byte == 0xf5) {
        value = byte == 0xf5;
        return true;
    }
    return ok_ = false;
}

bool CborReader::readNull() {
    if (position_ < size_ && (data_[position_] == 0xf6 || data_[position_] == 0xf7)) {
        position_++;
        return true;
    }
    return false;
}

bool CborReader::captureValue(std::vector<uint8_t>& value) {
    size_t start = position_;
    if (!skipValue()) return false;
    value.assign(data_ + start, data_ + position_);
    return true;
}

bool CborReader::skipValue() {
    if (position_ >= size_) return ok_ = false;
    uint8_t initial = data_[position_];
    uint8_t major = initial >> 5;
    if (major == 7) {
        position_++;
        uint8_t additional = initial & 0x1f;
        size_t extra = additional == 24 ? 1 : additional == 25 ? 2 : additional == 26 ? 4 : additional == 27 ? 8 : 0;
        if (position_ + extra > size_) return ok_ = false;
        position_ += extra;
        return true;
    }
    uint8_t parsedMajor;
    uint64_t value;
    if (!readHeader(parsedMajor, value)) return false;
    if (parsedMajor == 2 || parsedMajor == 3) {
        if (position_ + value > size_) return ok_ = false;
        position_ += value;
        return true;
    }
    if (parsedMajor == 4) {
        for (uint64_t index = 0; index < value; ++index) if (!skipValue()) return false;
        return true;
    }
    if (parsedMajor == 5) {
        for (uint64_t index = 0; index < value; ++index) if (!skipValue() || !skipValue()) return false;
        return true;
    }
    if (parsedMajor == 6) return skipValue();
    return parsedMajor <= 1;
}

void CborWriter::header(uint8_t major, uint64_t value) {
    if (value < 24) data_.push_back(static_cast<uint8_t>((major << 5) | value));
    else if (value <= 0xff) {
        data_.push_back(static_cast<uint8_t>((major << 5) | 24));
        data_.push_back(static_cast<uint8_t>(value));
    } else if (value <= 0xffff) {
        data_.push_back(static_cast<uint8_t>((major << 5) | 25));
        data_.push_back(static_cast<uint8_t>(value >> 8));
        data_.push_back(static_cast<uint8_t>(value));
    } else {
        data_.push_back(static_cast<uint8_t>((major << 5) | 26));
        for (int shift = 24; shift >= 0; shift -= 8) data_.push_back(static_cast<uint8_t>(value >> shift));
    }
}

void CborWriter::map(size_t size) { header(5, size); }
void CborWriter::array(size_t size) { header(4, size); }
void CborWriter::text(const String& value) {
    header(3, value.length());
    data_.insert(data_.end(), value.begin(), value.end());
}
void CborWriter::text(const char* value) { text(String(value)); }
void CborWriter::bytes(const uint8_t* value, size_t size) {
    header(2, size);
    data_.insert(data_.end(), value, value + size);
}
void CborWriter::unsignedInteger(uint64_t value) { header(0, value); }
void CborWriter::boolean(bool value) { data_.push_back(value ? 0xf5 : 0xf4); }
void CborWriter::nullValue() { data_.push_back(0xf6); }

void FrameProtocol::poll(Stream& stream, const Handler& handler) {
    while (stream.available()) {
        uint8_t byte = static_cast<uint8_t>(stream.read());
        if (byte != 0) {
            if (receiveBuffer_.size() < 24 * 1024) receiveBuffer_.push_back(byte);
            else receiveBuffer_.clear();
            continue;
        }
        if (receiveBuffer_.empty()) continue;
        EnvelopeView envelope;
        if (decodeFrame(receiveBuffer_, envelope)) {
            if (envelope.sequence > lastReceivedSequence_) lastReceivedSequence_ = envelope.sequence;
            handler(envelope);
        }
        receiveBuffer_.clear();
    }
}

bool FrameProtocol::decodeFrame(const std::vector<uint8_t>& encoded, EnvelopeView& envelope) {
    std::vector<uint8_t> decoded;
    if (!cobsDecode(encoded, decoded) || decoded.size() < 5) return false;
    size_t payloadSize = decoded.size() - 4;
    uint32_t expected = (static_cast<uint32_t>(decoded[payloadSize]) << 24) |
                        (static_cast<uint32_t>(decoded[payloadSize + 1]) << 16) |
                        (static_cast<uint32_t>(decoded[payloadSize + 2]) << 8) |
                        decoded[payloadSize + 3];
    if (crc32(decoded.data(), payloadSize) != expected) return false;
    CborReader reader(decoded.data(), payloadSize);
    size_t fields;
    if (!reader.readMapSize(fields)) return false;
    for (size_t index = 0; index < fields; ++index) {
        String key;
        if (!reader.readText(key)) return false;
        if (key == "protocol") {
            uint64_t protocol;
            if (!reader.readUnsigned(protocol) || protocol != AGENTLING_PROTOCOL_VERSION) return false;
        } else if (key == "epoch") {
            uint64_t value;
            if (!reader.readUnsigned(value)) return false;
            envelope.epoch = static_cast<uint32_t>(value);
        } else if (key == "sequence") {
            uint64_t value;
            if (!reader.readUnsigned(value)) return false;
            envelope.sequence = static_cast<uint32_t>(value);
        } else if (key == "type") {
            if (!reader.readText(envelope.type)) return false;
        } else if (key == "payload") {
            if (!reader.captureValue(envelope.payload)) return false;
        } else if (!reader.skipValue()) return false;
    }
    return reader.good() && !envelope.type.isEmpty();
}

void FrameProtocol::send(Stream& stream, const String& type, const PayloadWriter& payloadWriter) {
    CborWriter payload;
    payloadWriter(payload);
    CborWriter envelope;
    envelope.map(7);
    envelope.key("protocol"); envelope.unsignedInteger(AGENTLING_PROTOCOL_VERSION);
    envelope.key("epoch"); envelope.unsignedInteger(epoch_);
    envelope.key("sequence"); envelope.unsignedInteger(++sequence_);
    envelope.key("ack"); envelope.unsignedInteger(lastReceivedSequence_);
    envelope.key("type"); envelope.text(type);
    envelope.key("sentAt"); envelope.unsignedInteger(millis());
    envelope.key("payload");
    std::vector<uint8_t> packet = envelope.data();
    packet.insert(packet.end(), payload.data().begin(), payload.data().end());
    uint32_t checksum = crc32(packet.data(), packet.size());
    packet.push_back(static_cast<uint8_t>(checksum >> 24));
    packet.push_back(static_cast<uint8_t>(checksum >> 16));
    packet.push_back(static_cast<uint8_t>(checksum >> 8));
    packet.push_back(static_cast<uint8_t>(checksum));
    std::vector<uint8_t> encoded;
    cobsEncode(packet, encoded);
    stream.write(encoded.data(), encoded.size());
    stream.write(static_cast<uint8_t>(0));
}

uint32_t FrameProtocol::crc32(const uint8_t* data, size_t size) {
    uint32_t crc = 0xffffffff;
    for (size_t index = 0; index < size; ++index) {
        crc ^= data[index];
        for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc ^ 0xffffffff;
}

bool FrameProtocol::cobsDecode(const std::vector<uint8_t>& input, std::vector<uint8_t>& output) {
    output.clear();
    size_t read = 0;
    while (read < input.size()) {
        uint8_t code = input[read++];
        if (code == 0 || read + code - 1 > input.size()) return false;
        for (uint8_t index = 1; index < code; ++index) output.push_back(input[read++]);
        if (code != 0xff && read < input.size()) output.push_back(0);
    }
    return true;
}

void FrameProtocol::cobsEncode(const std::vector<uint8_t>& input, std::vector<uint8_t>& output) {
    output.assign(input.size() + input.size() / 254 + 2, 0);
    size_t read = 0, write = 1, codeIndex = 0;
    uint8_t code = 1;
    while (read < input.size()) {
        if (input[read] == 0) {
            output[codeIndex] = code;
            codeIndex = write++;
            code = 1;
            ++read;
        } else {
            output[write++] = input[read++];
            if (++code == 0xff) {
                output[codeIndex] = code;
                codeIndex = write++;
                code = 1;
            }
        }
    }
    output[codeIndex] = code;
    output.resize(write);
}

}  // namespace agentling
