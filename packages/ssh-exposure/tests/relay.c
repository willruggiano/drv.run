#define main relay_main
#include "../relay.c"
#undef main
#include <assert.h>
#include <sys/un.h>

static void write_all(int fd, const void *data, size_t length) {
    const char *bytes = data;
    while (length) {
        ssize_t count = write(fd, bytes, length);
        assert(count > 0);
        bytes += count;
        length -= (size_t) count;
    }
}

static void read_all(int fd, void *data, size_t length) {
    char *bytes = data;
    while (length) {
        ssize_t count = read(fd, bytes, length);
        assert(count > 0);
        bytes += count;
        length -= (size_t) count;
    }
}

static void reap(pid_t child) {
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

static void mux(bool valid) {
    char directory[] = "/tmp/drv-run-ssh.XXXXXX";
    assert(mkdtemp(directory));
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    assert(snprintf(address.sun_path, sizeof(address.sun_path), "%s/mux", directory) > 0);
    int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    assert(listener >= 0);
    assert(bind(listener, (struct sockaddr *) &address, sizeof(address)) == 0);
    assert(listen(listener, 1) == 0);
    pid_t server = fork();
    assert(server >= 0);
    if (server == 0) {
        int fd = accept(listener, NULL, NULL);
        assert(fd >= 0);
        char request[sizeof("CONNECT 22\n") - 1];
        read_all(fd, request, sizeof(request));
        assert(memcmp(request, "CONNECT 22\n", sizeof(request)) == 0);
        if (valid) {
            write_all(fd, "OK ", 3);
            const unsigned char reply[] = {'2', '2', '\n', 0, 1, 2, 255};
            write_all(fd, reply, sizeof(reply));
        }
        close(fd);
        close(listener);
        _exit(0);
    }
    close(listener);
    char target[160];
    snprintf(target, sizeof(target), "vsock-mux%s", address.sun_path);
    int fd = backend(target);
    if (valid) {
        assert(fd >= 0);
        assert(fcntl(fd, F_GETFD) & FD_CLOEXEC);
        const unsigned char expected[] = {0, 1, 2, 255};
        unsigned char received[sizeof(expected)];
        read_all(fd, received, sizeof(received));
        assert(memcmp(received, expected, sizeof(expected)) == 0);
        assert(read(fd, received, 1) == 0);
        close(fd);
    } else {
        assert(fd < 0);
    }
    reap(server);
    assert(unlink(address.sun_path) == 0);
    assert(rmdir(directory) == 0);
}

static void transfer(bool reverse) {
    int client[2], guest[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, client) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    int size = 4096;
    for (size_t i = 0; i < 2; i++) {
        assert(setsockopt(client[i], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size)) == 0);
        assert(setsockopt(guest[i], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size)) == 0);
    }
    pid_t forwarder = fork();
    assert(forwarder >= 0);
    if (forwarder == 0) {
        close(client[0]);
        close(guest[0]);
        int result = reverse ? relay(guest[1], client[1]) : relay(client[1], guest[1]);
        close(client[1]);
        close(guest[1]);
        _exit(result < 0 ? 1 : 0);
    }
    close(client[1]);
    close(guest[1]);
    pid_t echo = fork();
    assert(echo >= 0);
    if (echo == 0) {
        close(client[0]);
        unsigned char data[4096];
        ssize_t count;
        while ((count = read(guest[0], data, sizeof(data))) > 0)
            write_all(guest[0], data, (size_t) count);
        assert(count == 0);
        // This response is sent only AFTER the client's write half closes.
        write_all(guest[0], "\x03\x04\x05", 3);
        close(guest[0]);
        _exit(0);
    }
    close(guest[0]);
    const size_t total = 2 * 1024 * 1024;
    pid_t writer = fork();
    assert(writer >= 0);
    if (writer == 0) {
        unsigned char data[1024];
        for (size_t i = 0; i < sizeof(data); i++)
            data[i] = i % 256;
        for (size_t i = 0; i < total; i += sizeof(data))
            write_all(client[0], data, sizeof(data));
        assert(shutdown(client[0], SHUT_WR) == 0);
        close(client[0]);
        _exit(0);
    }
    size_t received = 0;
    unsigned char data[4096];
    ssize_t count;
    while ((count = read(client[0], data, sizeof(data))) > 0) {
        for (ssize_t i = 0; i < count; i++, received++) {
            assert(received < total + 3);
            assert(data[i] == (received < total ? received % 256 : received - total + 3));
        }
    }
    assert(count == 0 && received == total + 3);
    close(client[0]);
    reap(writer);
    reap(echo);
    reap(forwarder);
}

int main(void) {
    mux(true);
    mux(false);
    assert(backend("vsock-mux/nonexistent/drv-run-test") < 0);
    transfer(false);
    transfer(true);
    int client[2], guest[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, client) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    write_all(client[0], "pending", 7);
    close(client[0]);
    close(guest[0]);
    assert(relay(client[1], guest[1]) < 0);
    close(client[1]);
    close(guest[1]);
    return 0;
}
