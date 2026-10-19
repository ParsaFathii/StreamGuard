// Copyright © 2026 Parsa Fathi — Apache-2.0
// SPDX-License-Identifier: Apache-2.0
//
// StreamGuard native event parser — C ABI implementation.
//
// The result owns everything (decoded std::string fields). No exception ever
// crosses the boundary; allocation failures surface as NULL from sg_parse or
// (size_t)-1 from sg_normalize_message. Ownership transfer is explicit:
// sg_parse() releases a make_unique-allocated object, sg_free() deletes it —
// exactly one sg_free() per successful sg_parse().

#include "streamguard/capi.h"

#include <cstring>
#include <memory>
#include <new>
#include <string>
#include <string_view>

#include "streamguard/parser.hpp"

struct sg_parse_result {
    bool ok = false;
    sg_status status = SG_OK;
    std::size_t error_offset = 0;
    char error_message[128] = {};
    char error_field[48] = {};

    sg::parser::OwnedEventRecord rec;  // valid only when ok
};

namespace {

using sg::parser::ParseStatus;

sg_status map_status(ParseStatus s) noexcept {
    switch (s) {
    case ParseStatus::Ok: return SG_OK;
    case ParseStatus::InvalidJson: return SG_INVALID_JSON;
    case ParseStatus::SchemaViolation: return SG_SCHEMA_VIOLATION;
    case ParseStatus::OversizedInput: return SG_OVERSIZED_INPUT;
    case ParseStatus::InvalidTimestamp: return SG_INVALID_TIMESTAMP;
    case ParseStatus::InvalidEnum: return SG_INVALID_ENUM;
    case ParseStatus::MissingField: return SG_MISSING_FIELD;
    case ParseStatus::EncodingError: return SG_ENCODING_ERROR;
    }
    return SG_INVALID_JSON;  // unreachable; defensive
}

// Common tail for string getters: NUL-terminated c_str from an owned std::string.
const char* ret_owned(const sg_parse_result* r, const std::string& s, std::size_t* len) noexcept {
    (void)r;
    if (len != nullptr) {
        *len = s.size();
    }
    return s.c_str();
}

}  // namespace

// Reverse mapping used by sg_status_name (sg_status -> C++ status name).
namespace {
sg::parser::ParseStatus map_back(sg_status s) noexcept {
    switch (s) {
    case SG_OK: return ParseStatus::Ok;
    case SG_INVALID_JSON: return ParseStatus::InvalidJson;
    case SG_SCHEMA_VIOLATION: return ParseStatus::SchemaViolation;
    case SG_OVERSIZED_INPUT: return ParseStatus::OversizedInput;
    case SG_INVALID_TIMESTAMP: return ParseStatus::InvalidTimestamp;
    case SG_INVALID_ENUM: return ParseStatus::InvalidEnum;
    case SG_MISSING_FIELD: return ParseStatus::MissingField;
    case SG_ENCODING_ERROR: return ParseStatus::EncodingError;
    }
    return ParseStatus::InvalidJson;
}
}  // namespace

extern "C" {

sg_parse_result* sg_parse(const char* data, size_t len) {
    std::unique_ptr<sg_parse_result> r;
    try {
        r = std::make_unique<sg_parse_result>();
    } catch (...) {
        return nullptr;  // allocation failure — documented NULL return
    }
    std::string_view input;
    if (data != nullptr) {
        input = std::string_view(data, len);
    } else if (len != 0) {
        // Defensive: NULL buffer with nonzero length cannot be read.
        r->status = SG_INVALID_JSON;
        std::memcpy(r->error_message, "null input buffer with nonzero length", 38);
        r->error_message[38 - 1] = '\0';
        return r.release();
    }
    const sg::parser::ParseResult res = sg::parser::parse_event(input);
    r->status = map_status(res.status);
    r->ok = (res.status == ParseStatus::Ok);
    r->error_offset = res.error.byte_offset;
    std::memcpy(r->error_message, res.error.message, sizeof(r->error_message));
    std::memcpy(r->error_field, res.error.field, sizeof(r->error_field));
    if (r->ok) {
        try {
            r->rec = res.event.to_owned();
        } catch (...) {
            return nullptr;  // allocation failure — documented NULL return
        }
    }
    return r.release();
}

void sg_free(sg_parse_result* result) { delete result; }

int sg_ok(const sg_parse_result* r) { return (r != nullptr && r->ok) ? 1 : 0; }

enum sg_status sg_parse_status(const sg_parse_result* r) { return r != nullptr ? r->status : SG_INVALID_JSON; }

size_t sg_error_byte_offset(const sg_parse_result* r) { return r != nullptr ? r->error_offset : 0; }

const char* sg_error_message(const sg_parse_result* r) {
    return r != nullptr ? r->error_message : "";
}

const char* sg_error_field(const sg_parse_result* r) { return r != nullptr ? r->error_field : ""; }

const char* sg_status_name(enum sg_status s) { return sg::parser::parse_status_name(map_back(s)); }

int32_t sg_schema_version(const sg_parse_result* r) {
    return (r != nullptr && r->ok) ? r->rec.schema_version : 0;
}

int64_t sg_event_time_unix_ms(const sg_parse_result* r) {
    return (r != nullptr && r->ok) ? r->rec.event_time_unix_ms() : 0;
}

const char* sg_event_id(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.event_id, len) : nullptr;
}

const char* sg_source_id(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.source_id, len) : nullptr;
}

const char* sg_source_type(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.source_type, len) : nullptr;
}

const char* sg_severity(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.severity, len) : nullptr;
}

const char* sg_category(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.category, len) : nullptr;
}

const char* sg_message(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.message, len) : nullptr;
}

const char* sg_message_normalized(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.message_normalized, len) : nullptr;
}

const char* sg_attributes_raw(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok) ? ret_owned(r, r->rec.attributes_raw, len) : nullptr;
}

const char* sg_correlation_id(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok && r->rec.has_correlation_id)
               ? ret_owned(r, r->rec.correlation_id, len)
               : nullptr;
}

const char* sg_trace_id(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok && r->rec.has_trace_id) ? ret_owned(r, r->rec.trace_id, len) : nullptr;
}

const char* sg_actor(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok && r->rec.has_actor) ? ret_owned(r, r->rec.actor, len) : nullptr;
}

const char* sg_origin(const sg_parse_result* r, size_t* len) {
    return (r != nullptr && r->ok && r->rec.has_origin) ? ret_owned(r, r->rec.origin, len) : nullptr;
}

size_t sg_attribute_count(const sg_parse_result* r) {
    return (r != nullptr && r->ok) ? r->rec.attributes.size() : 0;
}

const char* sg_attribute_key(const sg_parse_result* r, size_t index, size_t* len) {
    if (r == nullptr || !r->ok || index >= r->rec.attributes.size()) {
        if (len != nullptr) {
            *len = 0;
        }
        return nullptr;
    }
    return ret_owned(r, r->rec.attributes[index].key, len);
}

const char* sg_attribute_value(const sg_parse_result* r, size_t index, size_t* len) {
    if (r == nullptr || !r->ok || index >= r->rec.attributes.size()) {
        if (len != nullptr) {
            *len = 0;
        }
        return nullptr;
    }
    return ret_owned(r, r->rec.attributes[index].value, len);
}

enum sg_json_value_type sg_attribute_type(const sg_parse_result* r, size_t index) {
    if (r == nullptr || !r->ok || index >= r->rec.attributes.size()) {
        return SG_JSON_NULL;
    }
    switch (r->rec.attributes[index].type) {
    case sg::parser::JsonValueType::String: return SG_JSON_STRING;
    case sg::parser::JsonValueType::Number: return SG_JSON_NUMBER;
    case sg::parser::JsonValueType::Bool: return SG_JSON_BOOL;
    case sg::parser::JsonValueType::Null: return SG_JSON_NULL;
    case sg::parser::JsonValueType::Object: return SG_JSON_OBJECT;
    case sg::parser::JsonValueType::Array: return SG_JSON_ARRAY;
    }
    return SG_JSON_NULL;
}

const char* sg_attribute_find_value(const sg_parse_result* r, const char* key, size_t* len) {
    if (r == nullptr || !r->ok || key == nullptr) {
        if (len != nullptr) {
            *len = 0;
        }
        return nullptr;
    }
    const sg::parser::OwnedAttributeEntry* e = r->rec.find_attribute(std::string_view(key));
    if (e == nullptr || e->type != sg::parser::JsonValueType::String) {
        if (len != nullptr) {
            *len = 0;
        }
        return nullptr;
    }
    return ret_owned(r, e->value, len);
}

size_t sg_normalize_message(const char* in, size_t in_len, char* out, size_t out_cap) {
    if (in == nullptr) {
        return static_cast<size_t>(-1);
    }
    try {
        // Normalization never grows: raw.size() scratch always suffices.
        std::string tmp(in_len, '\0');
        const std::string_view nv =
            sg::parser::normalize_message(std::string_view(in, in_len), tmp.data(), tmp.size());
        if (out != nullptr && out_cap != 0) {
            const std::size_t n = nv.size() < out_cap - 1 ? nv.size() : out_cap - 1;
            std::memcpy(out, nv.data(), n);
            out[n] = '\0';
        }
        return nv.size();
    } catch (...) {
        return static_cast<size_t>(-1);
    }
}

}  // extern "C"
