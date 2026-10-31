# Recording image for the website's terminal recordings; see README.md.
FROM ghcr.io/charmbracelet/vhs@sha256:ea49a6a1c529be83153e88321892b5585964418f0b9055e8c1e0d732194234a3

# The base image's apt sources name the snapshot they were built from; pinning apt to
# it keeps the exact git version below installable. Snapshot Release files expire, so
# only the expiry check is relaxed; their signatures are still verified.
RUN sed -i \
      -e 's|^# \(http://snapshot.debian.org/archive/debian/20260918T000000Z\)$|URIs: \1|' \
      -e 's|^# \(http://snapshot.debian.org/archive/debian-security/20260918T000000Z\)$|URIs: \1|' \
      -e '/^URIs: http:\/\/deb.debian.org/d' \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::Check-Valid-Until=false update -qq \
  && apt-get install -y -qq --no-install-recommends git=1:2.47.3-0+deb13u1 \
  && rm -rf /var/lib/apt/lists/*
