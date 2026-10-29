#define main binder_main
#include "../bind.c"
#undef main
#include <assert.h>

int main(void) {
    uint64_t suffix;
    assert(instance_suffix("1", &suffix) && suffix == 1);
    assert(instance_suffix("11", &suffix) && suffix == 11);
    assert(instance_suffix("1000000000", &suffix) && suffix == 1000000000);
    assert(instance_suffix("4294967295", &suffix) && suffix == UINT32_MAX);
    const char *invalid[] = {"", "0", "01", "4294967296", "9999999999", "10000000000", "-1", "+1", "1/", "1\n", "1\xff", "abc", "ABC"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
        assert(!instance_suffix(invalid[i], &suffix));
    const struct owner policy[] = {
        {1000, "fd42:1:2:3::"},
        {1001, "fd42:1:2:4::"},
        {0, NULL},
    };
    struct in6_addr address, expected;
    assert(endpoint(policy, 1000, "1", &address));
    assert(inet_pton(AF_INET6, "fd42:1:2:3::1", &expected) == 1);
    assert(memcmp(&address, &expected, sizeof(address)) == 0);
    assert(endpoint(policy, 1001, "1", &address));
    assert(inet_pton(AF_INET6, "fd42:1:2:4::1", &expected) == 1);
    assert(memcmp(&address, &expected, sizeof(address)) == 0);
    assert(endpoint(policy, 1000, "4294967295", &address));
    assert(inet_pton(AF_INET6, "fd42:1:2:3::ffff:ffff", &expected) == 1);
    assert(memcmp(&address, &expected, sizeof(address)) == 0);
    assert(!endpoint(policy, 0, "1", &address));
    assert(!endpoint(policy, 1002, "1", &address));
    assert(!endpoint(policy, 1000, "../1", &address));
    return 0;
}
