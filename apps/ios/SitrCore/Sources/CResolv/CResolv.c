#include "CResolv.h"

#include <netdb.h>
#include <resolv.h>
#include <string.h>
#include <sys/socket.h>

// Public libresolv API, linked normally (Package.swift: linkedLibrary
// "resolv"). resolv.h maps these names to libresolv's res_9_* exports.
int sitr_system_resolvers(char *out, int slot_len, int max_slots) {
    struct __res_state state;
    memset(&state, 0, sizeof state);
    if (res_ninit(&state) != 0) return -1;
    union res_sockaddr_union servers[8];
    int n = res_getservers(&state, servers, 8);
    int found = 0;
    for (int i = 0; i < n && found < max_slots; i++) {
        struct sockaddr *sa = (struct sockaddr *)&servers[i];
        if (sa->sa_family != AF_INET && sa->sa_family != AF_INET6) continue;
        if (getnameinfo(sa, sa->sa_len, out + found * slot_len, (socklen_t)slot_len, NULL, 0, NI_NUMERICHOST) == 0) {
            found++;
        }
    }
    res_ndestroy(&state);
    return found;
}
