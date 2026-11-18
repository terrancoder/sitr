#include "CResolv.h"

#include <dlfcn.h>
#include <netdb.h>
#include <resolv.h>
#include <string.h>
#include <sys/socket.h>

// libresolv is opened at call time rather than linked, so the Release app
// (which links SitrCore but never calls this) gains no new load command.
typedef int (*ninit_fn)(res_state);
typedef int (*getservers_fn)(res_state, union res_sockaddr_union *, int);
typedef void (*ndestroy_fn)(res_state);

int sitr_system_resolvers(char *out, int slot_len, int max_slots) {
    void *lib = dlopen("/usr/lib/libresolv.9.dylib", RTLD_LAZY | RTLD_LOCAL);
    if (!lib) return -1;
    ninit_fn ninit = (ninit_fn)dlsym(lib, "res_9_ninit");
    getservers_fn getservers = (getservers_fn)dlsym(lib, "res_9_getservers");
    ndestroy_fn ndestroy = (ndestroy_fn)dlsym(lib, "res_9_ndestroy");
    if (!ninit || !getservers || !ndestroy) return -1;

    struct __res_state state;
    memset(&state, 0, sizeof state);
    if (ninit(&state) != 0) return -1;
    union res_sockaddr_union servers[8];
    int n = getservers(&state, servers, 8);
    int found = 0;
    for (int i = 0; i < n && found < max_slots; i++) {
        struct sockaddr *sa = (struct sockaddr *)&servers[i];
        if (sa->sa_family != AF_INET && sa->sa_family != AF_INET6) continue;
        if (getnameinfo(sa, sa->sa_len, out + found * slot_len, (socklen_t)slot_len, NULL, 0, NI_NUMERICHOST) == 0) {
            found++;
        }
    }
    ndestroy(&state);
    return found;
}
