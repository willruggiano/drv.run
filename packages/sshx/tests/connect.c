#define main connect_main
#include "../connect.c"
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

static void transfer(bool pipes) {
    int input[2], output[2], guest[2];
    if (pipes) {
        assert(pipe(input) == 0);
        assert(pipe(output) == 0);
    } else {
        int client[2];
        assert(socketpair(AF_UNIX, SOCK_STREAM, 0, client) == 0);
        input[0] = client[1];
        input[1] = client[0];
        output[0] = dup(client[0]);
        output[1] = dup(client[1]);
    }
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    int size = 4096;
    for (size_t i = 0; i < 2; i++)
        assert(setsockopt(guest[i], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size)) == 0);
    pid_t forwarder = fork();
    assert(forwarder >= 0);
    if (forwarder == 0) {
        close(input[1]);
        close(output[0]);
        close(guest[0]);
        _exit(relay(input[0], output[1], guest[1]) < 0 ? 1 : 0);
    }
    close(input[0]);
    close(output[1]);
    close(guest[1]);
    pid_t echo = fork();
    assert(echo >= 0);
    if (echo == 0) {
        close(input[1]);
        close(output[0]);
        unsigned char data[4096];
        ssize_t count;
        while ((count = read(guest[0], data, sizeof(data))) > 0)
            write_all(guest[0], data, (size_t) count);
        assert(count == 0);
        // Reply only AFTER upload EOF; EOF is not a disconnect deadline.
        write_all(guest[0], "\x03\x04\x05", 3);
        close(guest[0]);
        _exit(0);
    }
    close(guest[0]);
    const size_t total = 2 * 1024 * 1024;
    pid_t writer = fork();
    assert(writer >= 0);
    if (writer == 0) {
        close(output[0]);
        unsigned char data[1024];
        for (size_t i = 0; i < sizeof(data); i++)
            data[i] = i % 256;
        for (size_t i = 0; i < total; i += sizeof(data))
            write_all(input[1], data, sizeof(data));
        if (!pipes)
            assert(shutdown(input[1], SHUT_WR) == 0);
        close(input[1]);
        _exit(0);
    }
    close(input[1]);
    size_t received = 0;
    unsigned char data[4096];
    ssize_t count;
    while ((count = read(output[0], data, sizeof(data))) > 0) {
        for (ssize_t i = 0; i < count; i++, received++) {
            assert(received < total + 3);
            assert(data[i] == (received < total ? received % 256 : received - total + 3));
        }
    }
    assert(count == 0 && received == total + 3);
    close(output[0]);
    reap(writer);
    reap(echo);
    reap(forwarder);
}

static void remote_eof(void) {
    int input[2], output[2], guest[2];
    assert(pipe(input) == 0 && pipe(output) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
        close(input[1]); close(output[0]); close(guest[0]);
        _exit(relay(input[0], output[1], guest[1]) < 0 ? 1 : 0);
    }
    close(input[0]); close(output[1]); close(guest[1]);
    assert(shutdown(guest[0], SHUT_WR) == 0);
    char byte;
    assert(read(output[0], &byte, 1) == 0);
    // The upload remains usable after the download half has closed.
    write_all(input[1], "x", 1);
    read_all(guest[0], &byte, 1);
    assert(byte == 'x');
    close(input[1]);
    assert(read(guest[0], &byte, 1) == 0);
    close(output[0]); close(guest[0]);
    reap(child);
}

static void peer_close(void) {
    int input[2], output[2], guest[2];
    assert(pipe(input) == 0 && pipe(output) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    unsigned char payload[32768];
    for (size_t i = 0; i < sizeof(payload); i++)
        payload[i] = i % 256;
    write_all(guest[0], payload, sizeof(payload));
    close(guest[0]);
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
        close(input[1]); close(output[0]);
        _exit(relay(input[0], output[1], guest[1]) < 0 ? 1 : 0);
    }
    close(input[0]); close(output[1]); close(guest[1]);
    unsigned char received[sizeof(payload)];
    read_all(output[0], received, sizeof(received));
    assert(memcmp(payload, received, sizeof(payload)) == 0);
    assert(read(output[0], received, 1) == 0);
    // A full peer close drains its final reply and exits, even with stdin open.
    reap(child);
    close(input[1]); close(output[0]);
}

static void cancellation(void) {
    int input[2], output[2], guest[2], ready[2];
    assert(pipe(input) == 0 && pipe(output) == 0 && pipe(ready) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
        close(ready[0]);
        write_all(ready[1], "x", 1);
        close(ready[1]);
        _exit(relay(input[0], output[1], guest[1]) < 0 ? 1 : 0);
    }
    close(ready[1]);
    char byte;
    read_all(ready[0], &byte, 1);
    assert(kill(child, SIGTERM) == 0);
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFSIGNALED(status) && WTERMSIG(status) == SIGTERM);
    close(ready[0]);
    for (size_t i = 0; i < 2; i++) {
        close(input[i]); close(output[i]); close(guest[i]);
    }
}

int main(int argc, char **argv) {
    assert(signal(SIGPIPE, SIG_IGN) != SIG_ERR);
    // Real sshd integration supplies a temporary mux instead of /run/user.
    if (argc == 2 || argc == 3) {
        if (argc == 3 && !instance_name(argv[1]))
            return 1;
        int fd = backend(argv[argc - 1]);
        return fd < 0 || relay(STDIN_FILENO, STDOUT_FILENO, fd) < 0;
    }
    assert(argc == 1);
    assert(instance_name("drv.run.0123456789abcdef"));
    const char *invalid[] = {"", "../guest", "drv.run.", "drv.run.0123456789abcdef/", "drv.run.0123456789abcdef extra", "drv.run.0123456789abcde-", "drv.run.0123456789abcdeé", "drv.run.0123456789ABCDEF"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
        assert(!instance_name(invalid[i]));
    peer_close();
    mux(true);
    mux(false);
    assert(backend("vsock-mux/nonexistent/drv-run-test") < 0);
    transfer(false);
    transfer(true);
    remote_eof();
    cancellation();
    int input[2], output[2], guest[2];
    assert(pipe(input) == 0 && pipe(output) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, guest) == 0);
    write_all(guest[0], "undeliverable", 13);
    close(output[0]);
    assert(relay(input[0], output[1], guest[1]) < 0);
    close(input[0]); close(input[1]); close(guest[0]); close(guest[1]);
    return 0;
}
