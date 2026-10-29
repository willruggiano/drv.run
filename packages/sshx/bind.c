#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/capability.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <unistd.h>
#include "instance.h"

struct owner {
    uid_t uid;
    const char *prefix;
};
#include "policy.h"

static bool endpoint(const struct owner *policy, uid_t uid, const char *id, struct in6_addr *address) {
    uint64_t suffix;
    if (uid == 0 || !instance_suffix(id, &suffix))
        return false;
    for (const struct owner *owner = policy; owner->prefix; owner++) {
        if (owner->uid != uid)
            continue;
        if (inet_pton(AF_INET6, owner->prefix, address) != 1)
            return false;
        for (size_t i = 0; i < 8; i++) {
            address->s6_addr[15 - i] = suffix & 0xff;
            suffix >>= 8;
        }
        return true;
    }
    return false;
}

static void check(int result, const char *operation) {
    if (result < 0) {
        perror(operation);
        exit(EXIT_FAILURE);
    }
}

int main(int argc, char **argv) {
    struct sockaddr_in6 address = {.sin6_family = AF_INET6, .sin6_port = htons(22)};
    if (argc != 2 || getuid() != geteuid() || !endpoint(owners, getuid(), argv[1], &address.sin6_addr)) {
        fputs("sshx.bind: requires a configured owner and a ten-character instance ID\n", stderr);
        return EXIT_FAILURE;
    }

    // Do not forward caller-supplied descriptors to the acceptor.
    check(close_range(3, UINT_MAX, 0), "close inherited descriptors");
    int fd = socket(AF_INET6, SOCK_STREAM | SOCK_CLOEXEC, 0);
    check(fd, "socket");
    int yes = 1;
    check(setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &yes, sizeof(yes)), "IPv6 only");
    check(setsockopt(fd, IPPROTO_IPV6, IPV6_FREEBIND, &yes, sizeof(yes)), "free bind");
    check(setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)), "reuse address");
    check(bind(fd, (struct sockaddr *) &address, sizeof(address)), "bind endpoint");

    // The NixOS wrapper grants only CAP_NET_BIND_SERVICE. Neither the acceptor
    // nor its children need it, and exec must not be able to regain privileges.
    cap_t empty = cap_init();
    if (!empty) {
        perror("cap_init");
        return EXIT_FAILURE;
    }
    check(cap_set_proc(empty), "drop capabilities");
    cap_free(empty);
    check(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no new privileges");
    check(listen(fd, SOMAXCONN), "listen");
    check(dup2(fd, 3), "activation descriptor");
    if (fd != 3)
        close(fd);
    check(fcntl(3, F_SETFD, 0), "inherit listener");
    char pid[32];
    snprintf(pid, sizeof(pid), "%jd", (intmax_t) getpid());
    check(setenv("LISTEN_PID", pid, 1), "LISTEN_PID");
    check(setenv("LISTEN_FDS", "1", 1), "LISTEN_FDS");
    check(unsetenv("LISTEN_PIDFDID"), "LISTEN_PIDFDID");
    check(unsetenv("LISTEN_FDNAMES"), "LISTEN_FDNAMES");
    execl(ACTIVATE, ACTIVATE, "--accept", "--inetd", RELAY, argv[1], (char *) NULL);
    perror("exec systemd-socket-activate");
    return EXIT_FAILURE;
}
