#define main binder_main
#include "../bind.c"
#undef main
#include <assert.h>

int main(void) {
    uint64_t suffix;
    assert(instance_suffix("0000000000", &suffix) && suffix == 1);
    assert(instance_suffix("000000000A", &suffix) && suffix == 11);
    assert(instance_suffix("000000000a", &suffix) && suffix == 37);
    assert(instance_suffix("0000000010", &suffix) && suffix == 63);
    assert(instance_suffix("zzzzzzzzzz", &suffix) && suffix == UINT64_C(839299365868340224));
    const char *invalid[] = {"", "000000000", "00000000000", "../0000000", "000000000-", "000000000\n", "000000000\xff"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
        assert(!instance_suffix(invalid[i], &suffix));
    const struct owner policy[] = {
        {1000, "fd42:1:2:3::"},
        {1001, "fd42:1:2:4::"},
        {0, NULL},
    };
    struct in6_addr address, expected;
    assert(endpoint(policy, 1000, "0000000000", &address));
    assert(inet_pton(AF_INET6, "fd42:1:2:3::1", &expected) == 1);
    assert(memcmp(&address, &expected, sizeof(address)) == 0);
    assert(endpoint(policy, 1001, "0000000000", &address));
    assert(inet_pton(AF_INET6, "fd42:1:2:4::1", &expected) == 1);
    assert(memcmp(&address, &expected, sizeof(address)) == 0);
    assert(endpoint(policy, 1000, "zzzzzzzzzz", &address));
    assert(inet_pton(AF_INET6, "fd42:1:2:3:ba5:ca53:92cb:400", &expected) == 1);
    assert(memcmp(&address, &expected, sizeof(address)) == 0);
    assert(!endpoint(policy, 0, "0000000000", &address));
    assert(!endpoint(policy, 1002, "0000000000", &address));
    assert(!endpoint(policy, 1000, "../0000000", &address));
    return 0;
}
