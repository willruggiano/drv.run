#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include "instance.h"

static int backend(const char *address) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) < 0)
        return -1;
    pid_t child = fork();
    if (child < 0) {
        int error = errno;
        close(pair[0]);
        close(pair[1]);
        errno = error;
        return -1;
    }
    if (child == 0) {
        if (dup2(pair[1], STDOUT_FILENO) < 0 || close_range(3, UINT_MAX, 0) < 0)
            _exit(EXIT_FAILURE);
        close(STDIN_FILENO);
        execl(PROXY, PROXY, address, "22", (char *) NULL);
        _exit(EXIT_FAILURE);
    }
    close(pair[1]);
    char byte;
    struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    union {
        struct cmsghdr align;
        char bytes[CMSG_SPACE(sizeof(int))];
    } control;
    struct msghdr message = {
        .msg_iov = &iov, .msg_iovlen = 1,
        .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes),
    };
    ssize_t received;
    do {
        received = recvmsg(pair[0], &message, MSG_CMSG_CLOEXEC);
    } while (received < 0 && errno == EINTR);
    close(pair[0]);
    int fd = -1;
    if (received == 1) {
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        if (!(message.msg_flags & (MSG_CTRUNC | MSG_TRUNC)) && header &&
            header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS &&
            header->cmsg_len == CMSG_LEN(sizeof(int)) && !CMSG_NXTHDR(&message, header)) {
            memcpy(&fd, CMSG_DATA(header), sizeof(fd));
        } else {
            // Close any descriptors received with a malformed reply.
            for (; header; header = CMSG_NXTHDR(&message, header)) {
                if (header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS) {
                    size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
                    for (size_t i = 0; i < count; i++) {
                        int extra;
                        memcpy(&extra, CMSG_DATA(header) + i * sizeof(int), sizeof(extra));
                        close(extra);
                    }
                }
            }
        }
    }
    int status;
    pid_t waited;
    do {
        waited = waitpid(child, &status, 0);
    } while (waited < 0 && errno == EINTR);
    if (waited < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0 || fd < 0) {
        if (fd >= 0)
            close(fd);
        errno = EPROTO;
        return -1;
    }
    return fd;
}

struct direction {
    unsigned char data[16384];
    size_t used;
    bool eof, shutdown;
};

static int relay(int client, int guest) {
    int sockets[2] = {client, guest};
    struct direction directions[2] = {0};
    for (size_t i = 0; i < 2; i++) {
        int flags = fcntl(sockets[i], F_GETFL);
        if (flags < 0 || fcntl(sockets[i], F_SETFL, flags | O_NONBLOCK) < 0)
            return -1;
    }
    for (;;) {
        struct pollfd events[2] = {0};
        for (size_t i = 0; i < 2; i++) {
            struct direction *out = &directions[i], *in = &directions[1 - i];
            if (out->eof && out->used == 0 && !out->shutdown) {
                if (shutdown(sockets[1 - i], SHUT_WR) < 0 && errno != ENOTCONN)
                    return -1;
                out->shutdown = true;
            }
            if (!out->eof && out->used < sizeof(out->data))
                events[i].events |= POLLIN;
            if (in->used)
                events[i].events |= POLLOUT;
            events[i].fd = events[i].events ? sockets[i] : -1;
        }
        if (directions[0].shutdown && directions[1].shutdown)
            return 0;
        if (poll(events, 2, -1) < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        for (size_t i = 0; i < 2; i++) {
            struct direction *out = &directions[i], *in = &directions[1 - i];
            if (events[i].revents & (POLLERR | POLLNVAL)) {
                errno = EIO;
                return -1;
            }
            if ((events[i].revents & (POLLIN | POLLHUP)) && !out->eof && out->used < sizeof(out->data)) {
                ssize_t count = read(sockets[i], out->data + out->used, sizeof(out->data) - out->used);
                if (count > 0)
                    out->used += (size_t) count;
                else if (count == 0)
                    out->eof = true;
                else if (errno != EAGAIN && errno != EINTR)
                    return -1;
            }
            if ((events[i].revents & POLLOUT) && in->used) {
                ssize_t count = send(sockets[i], in->data, in->used, MSG_NOSIGNAL);
                if (count > 0) {
                    in->used -= (size_t) count;
                    memmove(in->data, in->data + count, in->used);
                } else if (count < 0 && errno != EAGAIN && errno != EINTR)
                    return -1;
            }
        }
    }
}

int main(int argc, char **argv) {
    uint64_t suffix;
    if (argc != 2 || !instance_suffix(argv[1], &suffix))
        return EXIT_FAILURE;
    char address[128];
    snprintf(address, sizeof(address), "vsock-mux/run/user/%ju/drv.run.%s/notify.vsock",
             (uintmax_t) getuid(), argv[1]);
    int fd = backend(address);
    if (fd < 0) {
        perror("connect guest");
        return EXIT_FAILURE;
    }
    int result = relay(STDIN_FILENO, fd);
    if (result < 0)
        perror("relay");
    close(fd);
    return result < 0 ? EXIT_FAILURE : EXIT_SUCCESS;
}
