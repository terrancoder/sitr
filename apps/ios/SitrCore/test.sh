#!/bin/sh
# Run the SitrCore test suite.
#
# With full Xcode installed, plain `swift test` works. With only the
# Command Line Tools, the Swift Testing framework exists but is not on the
# default search path — this script adds it. CI (macos runners with Xcode)
# can use either invocation.
set -e
cd "$(dirname "$0")"

if xcodebuild -version >/dev/null 2>&1; then
  exec swift test "$@"
fi

CLT=/Library/Developer/CommandLineTools
FWK="$CLT/Library/Developer/Frameworks"
LIB="$CLT/Library/Developer/usr/lib"
exec swift test \
  -Xswiftc -F -Xswiftc "$FWK" \
  -Xlinker -F -Xlinker "$FWK" \
  -Xlinker -rpath -Xlinker "$FWK" \
  -Xlinker -rpath -Xlinker "$LIB" \
  "$@"
