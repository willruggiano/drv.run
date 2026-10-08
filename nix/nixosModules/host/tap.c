// Unprivileged nsresourced TAP allocation, then exec the pinned CH runner.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <systemd/sd-json.h>
#include <systemd/sd-varlink.h>

static void check(int result, const char *operation) {
    if (result < 0) {
        fprintf(stderr, "drv-run-tap: %s: %s\n", operation, strerror(-result));
        exit(EXIT_FAILURE);
    }
}

// The child creates an empty namespace, not a sandbox for the VMM. The parent
// pins it with an FD, then reaps the child before contacting nsresourced.
static int empty_userns(void) {
    int ready[2], done[2];
    if (pipe2(ready, O_CLOEXEC) < 0 || pipe2(done, O_CLOEXEC) < 0)
        check(-errno, "pipe2");
    pid_t parent = getpid(), child = fork();
    if (child < 0)
        check(-errno, "fork");
    if (child == 0) {
        close(ready[0]);
        close(done[1]);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != parent)
            _exit(EXIT_FAILURE);
        int error = unshare(CLONE_NEWUSER) < 0 ? errno : 0;
        if (write(ready[1], &error, sizeof(error)) != sizeof(error))
            _exit(EXIT_FAILURE);
        close(ready[1]);
        char byte;
        if (error || read(done[0], &byte, 1) != 0)
            _exit(EXIT_FAILURE);
        _exit(EXIT_SUCCESS);
    }
    close(ready[1]);
    close(done[0]);
    int error = EIO;
    ssize_t count = read(ready[0], &error, sizeof(error));
    close(ready[0]);
    char path[64];
    snprintf(path, sizeof(path), "/proc/%ld/ns/user", (long) child);
    int fd = count == sizeof(error) && error == 0 ? open(path, O_RDONLY | O_CLOEXEC) : -1;
    if (fd < 0 && count == sizeof(error) && error == 0)
        error = errno;
    close(done[1]);
    int status;
    if (waitpid(child, &status, 0) < 0)
        check(-errno, "waitpid");
    if (fd < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        check(-(error ? error : EIO), "create user namespace");
    return fd;
}

static sd_json_variant *call(sd_varlink *link, const char *method, const char *json) {
    sd_json_variant *parameters = NULL, *reply = NULL;
    const char *error = NULL;
    check(sd_json_parse(json, 0, &parameters, NULL, NULL), "parse parameters");
    int result = sd_varlink_call(link, method, parameters, &reply, &error);
    sd_json_variant_unref(parameters);
    check(result, method);
    if (error) {
        fprintf(stderr, "drv-run-tap: %s: %s\n", method, error);
        exit(EXIT_FAILURE);
    }
    return reply; // borrowed from link; valid until the next call
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: drv-run-tap RUNNER [ARGUMENT...]\n");
        return EXIT_FAILURE;
    }
    if (getuid() == 0 || getuid() != getgid()) {
        fprintf(stderr, "drv-run-tap: requires an unprivileged owner with matching UID and primary GID\n");
        return EXIT_FAILURE;
    }
    int userns = empty_userns();
    sd_varlink *link = NULL;
    check(sd_varlink_connect_address(&link, "/run/systemd/io.systemd.NamespaceResource"), "connect nsresourced");
    check(sd_varlink_set_relative_timeout(link, 30 * 1000000ULL), "set timeout");
    check(sd_varlink_set_allow_fd_passing_input(link, 1), "allow input FDs");
    check(sd_varlink_set_allow_fd_passing_output(link, 1), "allow output FDs");
    int index = sd_varlink_push_dup_fd(link, userns);
    check(index, "send user namespace");
    char parameters[256];
    // Delegate mapping to nsresourced; the VMM stays in the Host user namespace.
    snprintf(parameters, sizeof(parameters),
             "{\"name\":\"drv-%ld\",\"mangleName\":true,\"type\":\"self\",\"size\":1,\"target\":0,\"userNamespaceFileDescriptor\":%d}",
             (long) getpid(), index);
    call(link, "io.systemd.NamespaceResource.AllocateUserRange", parameters);
    index = sd_varlink_push_dup_fd(link, userns);
    check(index, "send user namespace");
    snprintf(parameters, sizeof(parameters), "{\"mode\":\"tap\",\"userNamespaceFileDescriptor\":%d}", index);
    sd_json_variant *reply = call(link, "io.systemd.NamespaceResource.AddNetworkToUserNamespace", parameters);
    sd_json_variant *value = sd_json_variant_by_key(reply, "interfaceFileDescriptor");
    if (!sd_json_variant_is_unsigned(value) || sd_json_variant_unsigned(value) > INT_MAX)
        check(-EBADMSG, "TAP FD index");
    int tap = sd_varlink_take_fd(link, sd_json_variant_unsigned(value));
    check(tap, "receive TAP");
    sd_varlink_unref(link);
    // Both FDs must survive exec. Closing the last TAP FD destroys the link;
    // retaining userns keeps nsresourced's registration alive with the VMM.
    if (fcntl(tap, F_SETFD, 0) < 0 || fcntl(userns, F_SETFD, 0) < 0)
        check(-errno, "inherit FDs");
    char number[32];
    snprintf(number, sizeof(number), "%d", tap);
    if (setenv("DRV_RUN_TAP_FD", number, 1) < 0)
        check(-errno, "set TAP FD");
    execv(argv[1], argv + 1);
    check(-errno, "exec runner");
    return EXIT_FAILURE;
}
