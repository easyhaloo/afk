#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RESOURCE_LIMIT 4
#define FILE_LIMIT 16384
#define OUTPUT_LIMIT 65536

struct resource {
  const char *id;
  const char *path;
  int present;
  size_t size;
  unsigned char bytes[FILE_LIMIT];
};

struct invocation {
  pid_t pid;
  unsigned long long identity;
  double started;
  double finished;
  double sampled;
  int status;
  size_t stdout_size;
  size_t stderr_size;
  unsigned char stdout_bytes[OUTPUT_LIMIT];
  unsigned char stderr_bytes[OUTPUT_LIMIT];
};

static void fail(void) {
  fputs("frozen-scratch-unavailable\n", stderr);
  _exit(125);
}

static void exec_fail(int descriptor) {
  int failure = errno ? errno : EIO;
  if (write(descriptor, &failure, sizeof(failure)) < 0) _exit(126);
  _exit(126);
}

static double now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) fail();
  return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static int safe_text(const char *text, size_t maximum, int path) {
  size_t length = strlen(text);
  if (!length || length > maximum || text[0] == '/' || text[length - 1] == '/') return 0;
  const char *segment = text;
  for (const char *cursor = text;; cursor++) {
    if (!*cursor || *cursor == '/') {
      size_t count = (size_t)(cursor - segment);
      if (!count || (count == 1 && segment[0] == '.') || (count == 2 && segment[0] == '.' && segment[1] == '.')) return 0;
      if (!*cursor) return 1;
      if (!path) return 0;
      segment = cursor + 1;
    } else if (!((*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z') ||
      (*cursor >= '0' && *cursor <= '9') || *cursor == '-' || *cursor == '_' || *cursor == '.')) return 0;
  }
}

static int is_hash(const char *text) {
  if (strlen(text) != 64) return 0;
  for (size_t index = 0; index < 64; index++) if (!((text[index] >= 'a' && text[index] <= 'f') || (text[index] >= '0' && text[index] <= '9'))) return 0;
  return 1;
}

static void snapshot(struct resource *resources, int count) {
  int root = open("/scratch", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) fail();
  for (int index = 0; index < count; index++) {
    struct resource *resource = &resources[index];
    char path[65];
    strcpy(path, resource->path);
    int parent = dup(root);
    if (parent < 0) fail();
    char *segment = path;
    char *slash;
    int absent = 0;
    while ((slash = strchr(segment, '/'))) {
      *slash = 0;
      int next = openat(parent, segment, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0 && errno == ENOENT) { absent = 1; break; }
      if (next < 0) fail();
      close(parent);
      parent = next;
      segment = slash + 1;
    }
    int descriptor = absent ? -1 : openat(parent, segment, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (!absent && descriptor < 0 && errno != ENOENT) fail();
    close(parent);
    resource->present = descriptor >= 0;
    resource->size = 0;
    if (descriptor < 0) continue;
    struct stat before;
    if (fstat(descriptor, &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1 || before.st_size < 0 || before.st_size > FILE_LIMIT) fail();
    while (resource->size < (size_t)before.st_size) {
      ssize_t received = read(descriptor, resource->bytes + resource->size, (size_t)before.st_size - resource->size);
      if (received <= 0) fail();
      resource->size += (size_t)received;
    }
    unsigned char extra;
    struct stat after;
    if (read(descriptor, &extra, 1) != 0 || fstat(descriptor, &after) || after.st_dev != before.st_dev || after.st_ino != before.st_ino ||
      after.st_nlink != 1 || after.st_size != before.st_size || after.st_mtim.tv_sec != before.st_mtim.tv_sec ||
      after.st_mtim.tv_nsec != before.st_mtim.tv_nsec || after.st_ctim.tv_sec != before.st_ctim.tv_sec || after.st_ctim.tv_nsec != before.st_ctim.tv_nsec) fail();
    close(descriptor);
  }
  close(root);
}

static void quiescent(void) {
  int status;
  pid_t waited;
  while ((waited = waitpid(-1, &status, WNOHANG)) > 0) {}
  if (waited != -1 || errno != ECHILD) fail();
  DIR *directory = opendir("/proc");
  if (!directory) fail();
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    char *end;
    long pid = strtol(entry->d_name, &end, 10);
    if (!*end && pid > 0 && pid != getpid()) fail();
  }
  closedir(directory);
}

static unsigned long long start_identity(pid_t pid) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) fail();
  char text[4096];
  ssize_t count = read(descriptor, text, sizeof(text) - 1);
  close(descriptor);
  if (count <= 0 || count == (ssize_t)sizeof(text) - 1) fail();
  text[count] = 0;
  char *tail = strrchr(text, ')');
  if (!tail) fail();
  char *state;
  char *token = strtok_r(tail + 1, " ", &state);
  for (int field = 3; field < 22 && token; field++) token = strtok_r(NULL, " ", &state);
  if (!token) fail();
  char *end;
  unsigned long long value = strtoull(token, &end, 10);
  if (*end || !value) fail();
  return value;
}

static void hex(const unsigned char *bytes, size_t size) {
  for (size_t index = 0; index < size; index++) printf("%02x", bytes[index]);
}

static void print_resources(struct resource *resources, int count) {
  putchar('[');
  for (int index = 0; index < count; index++) {
    struct resource *resource = &resources[index];
    if (index) putchar(',');
    printf("{\"id\":\"%s\",\"path\":\"%s\",\"present\":%s,\"hex\":", resource->id, resource->path, resource->present ? "true" : "false");
    if (!resource->present) fputs("null", stdout);
    else { putchar('"'); hex(resource->bytes, resource->size); putchar('"'); }
    putchar('}');
  }
  putchar(']');
}

static void invoke(char **command, double began, long timeout, long output_limit, size_t *total_output, struct invocation *observed) {
  quiescent();
  int output[2], errors[2], executed[2], gate[2];
  if (pipe2(output, O_CLOEXEC) || pipe2(errors, O_CLOEXEC) || pipe2(executed, O_CLOEXEC) || pipe2(gate, O_CLOEXEC)) fail();
  pid_t child = fork();
  if (child < 0) fail();
  if (!child) {
    close(gate[1]);
    char begin;
    if (read(gate[0], &begin, 1) != 1) exec_fail(executed[1]);
    int input = open("/dev/null", O_RDONLY);
    if (input < 0 || dup2(input, 0) < 0 || dup2(output[1], 1) < 0 || dup2(errors[1], 2) < 0) exec_fail(executed[1]);
    if (dup3(executed[1], 3, O_CLOEXEC) < 0) exec_fail(executed[1]);
    for (int descriptor = 4; descriptor < 64; descriptor++) close(descriptor);
    execvp(command[0], command);
    exec_fail(3);
  }
  close(output[1]); close(errors[1]); close(executed[1]); close(gate[0]);
  observed->pid = child;
  observed->identity = start_identity(child);
  observed->started = now_ms() - began;
  if (write(gate[1], "1", 1) != 1) fail();
  close(gate[1]);
  struct pollfd streams[3] = {{output[0], POLLIN, 0}, {errors[0], POLLIN, 0}, {executed[0], POLLIN, 0}};
  int open_streams = 3, exec_confirmed = 0, ended = 0, status = 0;
  while (open_streams || !ended) {
    if (now_ms() - began >= timeout) fail();
    int ready = poll(streams, 3, 10);
    if (ready < 0 && errno != EINTR) fail();
    for (int index = 0; index < 3; index++) {
      if (streams[index].fd < 0 || !streams[index].revents) continue;
      unsigned char chunk[4096];
      ssize_t count = read(streams[index].fd, chunk, sizeof(chunk));
      if (count < 0) fail();
      if (!count) {
        close(streams[index].fd); streams[index].fd = -1; open_streams--;
        if (index == 2) exec_confirmed = 1;
      } else if (index == 2) fail();
      else {
        if (*total_output + (size_t)count > (size_t)output_limit) fail();
        *total_output += (size_t)count;
        if (!index) { memcpy(observed->stdout_bytes + observed->stdout_size, chunk, (size_t)count); observed->stdout_size += (size_t)count; }
        else { memcpy(observed->stderr_bytes + observed->stderr_size, chunk, (size_t)count); observed->stderr_size += (size_t)count; }
      }
    }
    if (!ended) {
      pid_t waited = waitpid(child, &status, WNOHANG);
      if (waited < 0) fail();
      if (waited == child) { ended = 1; observed->finished = now_ms() - began; quiescent(); }
    }
  }
  if (!exec_confirmed || (!WIFEXITED(status) && !WIFSIGNALED(status))) fail();
  quiescent();
  observed->status = status;
}

static void print_invocation(const struct invocation *observed) {
  printf("\"invocation\":{\"pid\":%d,\"startedIdentity\":\"%llu\",\"execConfirmed\":true,\"startedMs\":%.6f,\"finishedMs\":%.6f,\"exitCode\":",
    observed->pid, observed->identity, observed->started, observed->finished);
  if (WIFEXITED(observed->status)) printf("%d", WEXITSTATUS(observed->status)); else fputs("null", stdout);
  fputs(",\"signal\":", stdout);
  if (WIFSIGNALED(observed->status)) printf("%d", WTERMSIG(observed->status)); else fputs("null", stdout);
  putchar('}');
}

static void print_output(const struct invocation *observed) {
  fputs(",\"stdoutHex\":\"", stdout); hex(observed->stdout_bytes, observed->stdout_size);
  fputs("\",\"stderrHex\":\"", stdout); hex(observed->stderr_bytes, observed->stderr_size);
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc < 15 || getpid() != 1 || getuid() != 1000 || getgid() != 1000 || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 ||
    prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) fail();
  DIR *fds = opendir("/proc/self/fd");
  if (!fds) fail();
  struct dirent *entry;
  while ((entry = readdir(fds))) {
    char *end;
    long descriptor = strtol(entry->d_name, &end, 10);
    if (!*end && descriptor > 2 && descriptor != dirfd(fds)) fail();
  }
  closedir(fds);
  if (strlen(argv[1]) != 36 || !safe_text(argv[1], 36, 0)) fail();
  for (int index = 2; index <= 5; index++) if (!is_hash(argv[index])) fail();
  if (strcmp(argv[6], "original") && strcmp(argv[6], "proposed")) fail();
  char *end;
  long timeout = strtol(argv[7], &end, 10);
  if (*end || timeout < 1 || timeout > 120000) fail();
  long output_limit = strtol(argv[8], &end, 10);
  if (*end || output_limit < 1 || output_limit > OUTPUT_LIMIT) fail();
  long resource_count = strtol(argv[9], &end, 10);
  if (*end || resource_count < 1 || resource_count > RESOURCE_LIMIT) fail();
  int separator = 10 + 2 * (int)resource_count;
  int recovery = argc > separator && !strcmp(argv[separator], "--recovery");
  const char *recovery_digest = NULL;
  char *recovery_input = NULL;
  if (recovery) {
    if (argc <= separator + 3 || !is_hash(argv[separator + 1]) || strlen(argv[separator + 2]) > FILE_LIMIT) fail();
    recovery_digest = argv[separator + 1];
    recovery_input = argv[separator + 2];
    separator += 3;
  }
  if (argc != separator + 4 || strcmp(argv[separator], "--") ||
    (strcmp(argv[separator + 1], "node") && strcmp(argv[separator + 1], "/usr/local/bin/node")) ||
    !argv[separator + 2][0] || argv[separator + 2][0] == '-' || strlen(argv[separator + 3]) > FILE_LIMIT) fail();
  if (recovery && !strcmp(recovery_input, argv[separator + 3])) fail();
  int phase_count = recovery ? 3 : 1;
  struct resource boundaries[4][RESOURCE_LIMIT] = {0};
  struct invocation invocations[3] = {0};
  for (int index = 0; index < resource_count; index++) {
    const char *id = argv[10 + 2 * index];
    const char *path = argv[11 + 2 * index];
    if (!safe_text(id, 32, 0) || !safe_text(path, 64, 1)) fail();
    for (int other = 0; other < index; other++) if (!strcmp(id, boundaries[0][other].id) || !strcmp(path, boundaries[0][other].path)) fail();
    for (int boundary = 0; boundary <= phase_count; boundary++) {
      boundaries[boundary][index].id = id;
      boundaries[boundary][index].path = path;
    }
  }
  double began = now_ms();
  quiescent();
  snapshot(boundaries[0], (int)resource_count);
  for (int index = 0; index < resource_count; index++) if (boundaries[0][index].present) fail();
  double initial_sampled = now_ms() - began;
  size_t total_output = 0, sampled_bytes = 0;
  int stopped_original = 0;
  for (int phase = 0; phase < phase_count; phase++) {
    char *command[] = { argv[separator + 1], argv[separator + 2], phase ? recovery_input : argv[separator + 3], NULL };
    invoke(command, began, timeout, output_limit, &total_output, &invocations[phase]);
    int status = invocations[phase].status;
    if (recovery && (phase ? !WIFEXITED(status) || WEXITSTATUS(status) != 0 : WIFEXITED(status) && WEXITSTATUS(status) == 0)) {
      if (strcmp(argv[6], "original") || !WIFEXITED(status)) fail();
      phase_count = phase + 1;
      stopped_original = 1;
    }
    snapshot(boundaries[phase + 1], (int)resource_count);
    invocations[phase].sampled = now_ms() - began;
    if (invocations[phase].sampled >= timeout) fail();
    for (int index = 0; index < resource_count; index++) sampled_bytes += boundaries[phase + 1][index].size;
  }
  if (2 * (sampled_bytes + total_output) + 8192 > 512 * 1024) fail();
  printf("{\"revision\":\"%s\",\"operationId\":\"%s\",\"inputDigest\":\"%s\",\"helperDigest\":\"%s\",\"artifactDigest\":\"%s\",\"candidateVersion\":\"%s\",",
    stopped_original ? "linux-native-original-exit-v1" : recovery ? "linux-native-scratch-recovery-v1" : "linux-native-scratch-v1", argv[1], argv[2], argv[3], argv[4], argv[6]);
  printf("\"initialSampledMs\":%.6f,\"initial\":", initial_sampled);
  print_resources(boundaries[0], (int)resource_count);
  if (recovery) fputs(",\"phases\":[", stdout);
  const char *names[] = { "fault", "recovery", "replay" };
  for (int phase = 0; phase < phase_count; phase++) {
    if (recovery) {
      if (phase) putchar(',');
      printf("{\"phase\":\"%s\",\"ordinal\":%d,\"invocationId\":\"%s:%d\",", names[phase], phase + 1, argv[1], phase + 1);
    } else putchar(',');
    printf("\"callInputDigest\":\"%s\",", phase ? recovery_digest : argv[5]);
    print_invocation(&invocations[phase]);
    printf(",\"sampledMs\":%.6f,\"final\":", invocations[phase].sampled);
    print_resources(boundaries[phase + 1], (int)resource_count);
    print_output(&invocations[phase]);
    if (recovery) putchar('}');
  }
  if (recovery) putchar(']');
  fputs("}\n", stdout);
  if (fflush(stdout) || ferror(stdout)) fail();
  return 0;
}
