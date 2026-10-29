#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

// Canonical decimal IDs map directly to dnsmasq's synthetic IPv6 suffixes.
// Zero is reserved for the prefix itself.
static inline bool instance_suffix(const char *id, uint64_t *suffix) {
    size_t length = strlen(id);
    if (length == 0 || length > 10 || id[0] == '0')
        return false;
    uint64_t value = 0;
    for (size_t i = 0; i < length; i++) {
        if (id[i] < '0' || id[i] > '9')
            return false;
        value = value * 10 + (uint64_t) (id[i] - '0');
    }
    if (value > UINT32_MAX)
        return false;
    *suffix = value;
    return true;
}
