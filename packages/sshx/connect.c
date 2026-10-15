#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int backend(const char *address) {
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) < 0)
        return -1;
    pid_t parent = getpid();
    pid_t child = fork();
    if (child < 0) {
        int error = errno;
        close(pair[0]);
        close(pair[1]);
        errno = error;
        return -1;
    }
    if (child == 0) {
        if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0 || getppid() != parent)
            _exit(EXIT_FAILURE);
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
    int type;
    socklen_t length = sizeof(type);
    struct sockaddr_storage peer;
    socklen_t peer_length = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) < 0 ||
        length != sizeof(type) || type != SOCK_STREAM ||
        getpeername(fd, (struct sockaddr *) &peer, &peer_length) < 0) {
        close(fd);
        errno = EPROTO;
        return -1;
    }
    return fd;
}

struct direction {
    int input, output;
    unsigned char data[16384];
    size_t used;
    bool eof, closed;
};

// Each direction owns its output descriptor. EOF drains buffered data before
// closing that half; the opposite direction remains usable indefinitely.
static int relay(int input, int output, int guest) {
    int upload = dup(guest);
    if (upload < 0)
        return -1;
    struct direction directions[2] = {
        {.input = input, .output = upload},
        {.input = guest, .output = output},
    };
    int result = -1;
    bool undelivered = false;
    for (size_t i = 0; i < 2; i++) {
        int fds[2] = {directions[i].input, directions[i].output};
        for (size_t j = 0; j < 2; j++) {
            int flags = fcntl(fds[j], F_GETFL);
            if (flags < 0 || fcntl(fds[j], F_SETFL, flags | O_NONBLOCK) < 0)
                goto finish;
        }
    }
    for (;;) {
        struct pollfd events[4] = {0};
        for (size_t i = 0; i < 2; i++) {
            struct direction *d = &directions[i];
            if (d->eof && d->used == 0 && !d->closed) {
                // stdout is a pipe in an SSH session, or a socket for inetd.
                if (shutdown(d->output, SHUT_WR) < 0 && errno != ENOTSOCK && errno != ENOTCONN)
                    goto finish;
                close(d->output);
                d->closed = true;
            }
            events[2 * i] = (struct pollfd) {
                .fd = !d->eof && d->used < sizeof(d->data) ? d->input : -1,
                .events = POLLIN,
            };
            events[2 * i + 1] = (struct pollfd) {
                .fd = d->closed ? -1 : d->output,
                .events = d->used ? POLLOUT : 0,
            };
        }
        if (directions[0].closed && directions[1].closed) {
            result = undelivered ? -1 : 0;
            if (undelivered)
                errno = EPIPE;
            break;
        }
        if (poll(events, 4, -1) < 0) {
            if (errno == EINTR)
                continue;
            goto finish;
        }
        if (events[1].revents & POLLHUP) {
            // A full peer close can accompany its final bytes. Stop uploading,
            // but drain the download before reporting any undelivered upload.
            undelivered |= directions[0].used != 0;
            directions[0].used = 0;
            directions[0].eof = true;
            events[0].revents = events[1].revents = 0;
        }
        for (size_t i = 0; i < 2; i++) {
            struct direction *d = &directions[i];
            short reading = events[2 * i].revents, writing = events[2 * i + 1].revents;
            if ((reading & (POLLERR | POLLNVAL)) || (writing & (POLLERR | POLLHUP | POLLNVAL))) {
                errno = EIO;
                goto finish;
            }
            if (reading & (POLLIN | POLLHUP)) {
                ssize_t count = read(d->input, d->data + d->used, sizeof(d->data) - d->used);
                if (count > 0)
                    d->used += (size_t) count;
                else if (count == 0)
                    d->eof = true;
                else if (errno != EAGAIN && errno != EINTR)
                    goto finish;
            }
            if (writing & POLLOUT) {
                ssize_t count = write(d->output, d->data, d->used);
                if (count > 0) {
                    d->used -= (size_t) count;
                    memmove(d->data, d->data + count, d->used);
                } else if (count == 0) {
                    errno = EIO;
                    goto finish;
                } else if (errno != EAGAIN && errno != EINTR)
                    goto finish;
            }
        }
    }
finish:;
    int error = errno;
    for (size_t i = 0; i < 2; i++) {
        if (!directions[i].closed)
            close(directions[i].output);
    }
    errno = error;
    return result;
}

static bool instance_name(const char *name) {
    const char prefix[] = "drv.run.";
    if (strncmp(name, prefix, sizeof(prefix) - 1) != 0)
        return false;
    const char *id = name + sizeof(prefix) - 1;
    return strlen(id) == 16 && strspn(id, "0123456789abcdef") == 16;
}

int main(int argc, char **argv) {
    if (argc != 2 || !instance_name(argv[1]) || isatty(STDIN_FILENO) || isatty(STDOUT_FILENO)) {
        fputs("Usage: drv.run.ssh <instance>\n", stderr);
        return EXIT_FAILURE;
    }
    // No inherited descriptors or environment variables select an owner/socket.
    if (close_range(3, UINT_MAX, 0) < 0 || signal(SIGPIPE, SIG_IGN) == SIG_ERR)
        return EXIT_FAILURE;
    char directory[128], ready[160], address[160];
    snprintf(directory, sizeof(directory), "/run/user/%ju/%s", (uintmax_t) getuid(), argv[1]);
    snprintf(ready, sizeof(ready), "%s/client.conf", directory);
    struct stat st;
    if (lstat(directory, &st) < 0 || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || access(ready, R_OK) < 0) {
        fputs("Guest is not ready for this owner\n", stderr);
        return EXIT_FAILURE;
    }
    snprintf(address, sizeof(address), "vsock-mux%s/notify.vsock", directory);
    int fd = backend(address);
    if (fd < 0) {
        perror("connect guest");
        return EXIT_FAILURE;
    }
    int result = relay(STDIN_FILENO, STDOUT_FILENO, fd);
    if (result < 0)
        perror("relay");
    close(fd);
    return result < 0 ? EXIT_FAILURE : EXIT_SUCCESS;
}
