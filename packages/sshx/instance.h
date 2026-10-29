#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

// Ten base-62 digits fit in 60 bits. Reserve suffix zero for the prefix itself.
static inline bool instance_suffix(const char *id, uint64_t *suffix) {
    static const char alphabet[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    if (strlen(id) != 10)
        return false;
    uint64_t value = 0;
    for (size_t i = 0; i < 10; i++) {
        const char *digit = strchr(alphabet, id[i]);
        if (!digit)
            return false;
        value = value * 62 + (uint64_t) (digit - alphabet);
    }
    *suffix = value + 1;
    return true;
}
