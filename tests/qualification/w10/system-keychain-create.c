#include <Security/Security.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char directory[PATH_MAX];
    if (!getcwd(directory, sizeof directory) ||
        strncmp(directory, "/private/tmp/afk-w10-", strlen("/private/tmp/afk-w10-")) ||
        strchr(directory + strlen("/private/tmp/afk-w10-"), '/') ||
        access("probe.keychain", F_OK) == 0 || access("probe.keychain-db", F_OK) == 0) return 2;
    char path[PATH_MAX];
    if (snprintf(path, sizeof path, "%s/probe.keychain", directory) >= sizeof path) return 2;
    unsigned char password[32];
    arc4random_buf(password, sizeof password);
    SecKeychainRef keychain = NULL;
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 3;
    OSStatus status = SecKeychainCreate(path, sizeof password, password, false, NULL, &keychain);
    if (keychain) CFRelease(keychain);
    return status == errSecSuccess ? 0 : 4;
}
