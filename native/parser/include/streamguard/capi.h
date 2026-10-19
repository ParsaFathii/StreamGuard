/* Copyright © 2026 Parsa Fathi — Apache-2.0 */
/* SPDX-License-Identifier: Apache-2.0 */
/*
 * StreamGuard native event parser — stable C ABI.
 *
 * Parses one StreamGuard event (CONTRACT.md §Event Schema, schema_version 1)
 * from `data` (NOT required to be NUL-terminated; len bytes are read).
 *
 * OWNERSHIP: sg_parse() returns a heap-allocated, self-contained result (all
 * strings decoded, NUL-terminated, owned by the result). The caller frees it
 * with exactly one sg_free() call. No other deallocation is needed — the pair
 * is valgrind/LSan clean. Thread-safety: sg_parse()/all accessors may be called
 * concurrently on DIFFERENT result objects; a single result object must not be
 * used from multiple threads simultaneously (sg_free racing an accessor is UB).
 *
 * NULL data with len > 0 yields an InvalidJson result (defensive, no crash).
 * sg_parse returns NULL only when an internal allocation failed.
 * Getters return NULL for absent optional fields or when the result is not Ok;
 * required-field getters return NULL when the result is not Ok, never
 * otherwise. `len` out-params are optional (pass NULL to ignore).
 */

#ifndef STREAMGUARD_CAPI_H
#define STREAMGUARD_CAPI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum sg_status {
    SG_OK = 0,
    SG_INVALID_JSON = 1,
    SG_SCHEMA_VIOLATION = 2,
    SG_OVERSIZED_INPUT = 3,
    SG_INVALID_TIMESTAMP = 4,
    SG_INVALID_ENUM = 5,
    SG_MISSING_FIELD = 6,
    SG_ENCODING_ERROR = 7
};

enum sg_json_value_type {
    SG_JSON_STRING = 0,
    SG_JSON_NUMBER = 1,
    SG_JSON_BOOL = 2,
    SG_JSON_NULL = 3,
    SG_JSON_OBJECT = 4,
    SG_JSON_ARRAY = 5
};

/* Opaque, self-contained parse result. */
typedef struct sg_parse_result sg_parse_result;

sg_parse_result* sg_parse(const char* data, size_t len);
void sg_free(sg_parse_result* result);

/* 1 when the event parsed and validated, else 0. */
int sg_ok(const sg_parse_result* r);
/* Named sg_parse_status (not sg_status) so the enum type name stays usable. */
enum sg_status sg_parse_status(const sg_parse_result* r);
size_t sg_error_byte_offset(const sg_parse_result* r);
/* NUL-terminated, never NULL for a non-NULL r; "" when not applicable. */
const char* sg_error_message(const sg_parse_result* r);
const char* sg_error_field(const sg_parse_result* r);
const char* sg_status_name(enum sg_status s);

/* Field getters (see ownership notes above). */
int32_t sg_schema_version(const sg_parse_result* r);
int64_t sg_event_time_unix_ms(const sg_parse_result* r); /* ms since Unix epoch, UTC */
const char* sg_event_id(const sg_parse_result* r, size_t* len);
const char* sg_source_id(const sg_parse_result* r, size_t* len);
const char* sg_source_type(const sg_parse_result* r, size_t* len);
const char* sg_severity(const sg_parse_result* r, size_t* len);
const char* sg_category(const sg_parse_result* r, size_t* len);
/* message as transmitted (decoded); sg_message_normalized additionally applies
 * whitespace trim/collapse (the form validated against the 1..512-char rule). */
const char* sg_message(const sg_parse_result* r, size_t* len);
const char* sg_message_normalized(const sg_parse_result* r, size_t* len);
/* Exact raw JSON source span of the attributes object; "" when absent. */
const char* sg_attributes_raw(const sg_parse_result* r, size_t* len);

/* Optional fields: NULL when absent (or when !sg_ok). */
const char* sg_correlation_id(const sg_parse_result* r, size_t* len);
const char* sg_trace_id(const sg_parse_result* r, size_t* len);
const char* sg_actor(const sg_parse_result* r, size_t* len);
const char* sg_origin(const sg_parse_result* r, size_t* len);

/* Shallow attribute index (complete — no entry cap, unlike the C++ fast path). */
size_t sg_attribute_count(const sg_parse_result* r);
const char* sg_attribute_key(const sg_parse_result* r, size_t index, size_t* len);
const char* sg_attribute_value(const sg_parse_result* r, size_t index, size_t* len);
enum sg_json_value_type sg_attribute_type(const sg_parse_result* r, size_t index);
/* Decoded string value of a top-level attribute, or NULL if the key is absent
 * or its value is not a JSON string. */
const char* sg_attribute_find_value(const sg_parse_result* r, const char* key, size_t* len);

/* Standalone normalization: trims and collapses whitespace. Writes at most
 * out_cap-1 bytes plus a NUL into out (out may be NULL / out_cap 0 to just
 * query the size). Returns the full normalized length, or (size_t)-1 on NULL
 * input / allocation failure. */
size_t sg_normalize_message(const char* in, size_t in_len, char* out, size_t out_cap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* STREAMGUARD_CAPI_H */
