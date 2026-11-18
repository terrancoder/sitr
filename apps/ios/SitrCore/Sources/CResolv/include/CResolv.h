#ifndef CRESOLV_H
#define CRESOLV_H

/// Numeric addresses of the system's current DNS servers, as libresolv's
/// res_ninit + res_getservers see them (IPv6 with its %scope when it has
/// one). Writes up to `max_slots` NUL-terminated strings of `slot_len`
/// bytes into `out`; returns how many, or -1 when res_ninit fails.
/// res_ninit holds at most MAXNS (3) servers. Not callable from Swift
/// otherwise: no SDK module exports resolv.h.
int sitr_system_resolvers(char *out, int slot_len, int max_slots);

#endif
