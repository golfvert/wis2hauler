# wis2hauler -- container image
#
# Per the maintainer's own decision (see the project notes, "single artifact"
# discussion, 2026-09-12): this image never builds anything. CI (a
# GitHub Actions workflow, not yet written) compiles the standalone
# executable once, ahead of time, with `bun build --compile`, and this
# Dockerfile only copies that already-built binary in. Do not add a
# `bun install`/`bun build` step here -- that would reintroduce a
# second build path this project deliberately avoided.
#
# CRITICAL, easy to get wrong: this base is Alpine (musl libc), so the
# binary handed to this Dockerfile MUST be compiled with a musl target
# -- `bun build --compile --target=bun-linux-x64-musl` (or
# `bun-linux-arm64-musl` for arm64 hosts) -- NOT the default
# `bun-linux-x64`/`bun-linux-arm64`, which are glibc-linked and fail
# immediately on Alpine with a dynamic-linker error ("not found", from
# a missing /lib/ld-linux..."). This is almost certainly a DIFFERENT
# compiled artifact than any glibc binary CI also produces for a plain
# standalone-binary release -- same source, same `bun build --compile`
# command, different --target, two output files. Multi-arch (x64 +
# arm64) means one musl-targeted build per architecture.
#
# CI (.github/workflows/release.yml) lays the two musl binaries out as
# dist/amd64/wis2hauler and dist/arm64/wis2hauler, then runs a single
# `docker buildx build --platform linux/amd64,linux/arm64 .` -- buildx
# builds each platform separately and sets TARGETARCH (to "amd64" or
# "arm64") for each one, which the COPY below uses to pick the matching
# binary. For a manual single-arch build, lay out just the one
# subdirectory you need and pass --build-arg TARGETARCH=amd64 (or
# arm64) explicitly, since without buildx nothing sets it for you:
#   docker build -t wis2hauler:latest --build-arg TARGETARCH=amd64 .

FROM alpine:3.24

# Populated automatically per-platform by `docker buildx build
# --platform ...`; must be declared (not just implicitly available)
# to be read by the COPY below. See the CI note above for a manual,
# non-buildx build.
ARG TARGETARCH

# ca-certificates: needed for TLS verification -- global.local-broker
# entries and GB1/GB2 both commonly use mqtts://, and Redis Cluster/TLS
# is plausible too. Alpine's base image ships neither certs nor a CA
# bundle by default; without this, any TLS connection fails verification.
# Nothing else in package.json needs a native/shared-lib dependency
# (ioredis, mqtt, js-yaml, winston, ajv, geoip-lite are all pure JS --
# geoip-lite's .dat files are bundled straight into the compiled binary,
# confirmed live earlier this session), so this is the only apk package
# actually required.
# Bun's musl-target compiled binary still dynamically links libstdc++.so.6
# for certain C++ runtime symbols (exception handling, std:: allocator/hash
# functions) even though it targets musl libc for everything else -- Alpine
# does not ship libstdc++ by default. Without it the binary fails at startup
# with "Error loading shared library libstdc++.so.6" plus a cascade of
# "Error relocating ...: symbol not found" (e.g. _ZSt17__throw_bad_allocv).
# libgcc is libstdc++'s own runtime dependency on Alpine, so both are needed.
RUN apk add --no-cache ca-certificates libstdc++ libgcc

# Default, but settable, non-root user/group -- per the maintainer's request.
# "Settable" is deliberately handled TWO different ways, for two
# different moments:
#   1. At IMAGE BUILD time, via --build-arg UID=.../--build-arg GID=...,
#      if you want a different baked-in default across all your
#      deployments (rebuild required).
#   2. At CONTAINER RUN time, with NO rebuild and NO entrypoint-script
#      machinery at all: docker-compose's own native `user:` field
#      (e.g. `user: "${PUID:-1000}:${PGID:-1000}"`) overrides whatever
#      user this image defaults to, for that one service, per
#      deployment. This works even for a UID/GID with no matching
#      /etc/passwd entry -- this binary never resolves a username, it
#      only ever reads/writes files by numeric uid/gid, so an
#      unregistered override UID is not a problem the way it can be
#      for tools that shell out or do name lookups.
# If bind-mounted volume ownership (the shared downloads dir, log dir)
# needs to be fixed up automatically instead of matched by hand on the
# host, the well-known alternative is a root-started entrypoint script
# that chowns then drops privileges via su-exec/gosu (the
# linuxserver.io PUID/PGID pattern) -- deliberately NOT done here, to
# keep this image to a single, static, root-never-needed USER line;
# revisit if volume-permission mismatches turn out to be a real
# recurring friction.
ARG UID=1000
ARG GID=1000
RUN addgroup -g "${GID}" wis2 \
	&& adduser -D -H -u "${UID}" -G wis2 -s /sbin/nologin wis2

# Mount points a real deployment's docker-compose.yml is expected to
# bind-mount into:
#   - /configuration.yml -- the config file itself, mounted directly
#     (not nested under a /config directory -- the maintainer's call: one file,
#     one mount, no wrapper directory to also create/own). See CMD
#     below.
#   - /downloads -- the SAME shared aria-download volume the separate
#     aria2 container downloads into. This app's own decode-write.ts
#     embedded-content fast path writes files here directly too,
#     bypassing aria2 entirely, so this container needs write access
#     even though aria2 itself is a separate container.
#   - /logs -- only relevant when a worker's own global.log.to is
#     "file" rather than the "stdout" default.
# /downloads and /logs are pre-created and chowned here (rather than
# left for Docker to auto-create on first mount, which would leave
# them root-owned) so they're writable by the `wis2` user from the
# first start, even before any volume is actually mounted over them.
# /configuration.yml is NOT pre-created -- it's always supplied by the
# bind mount, never baked into the image.
RUN mkdir -p /downloads /logs \
	&& chown -R wis2:wis2 /downloads /logs

COPY --chmod=0755 dist/${TARGETARCH}/wis2hauler /usr/local/bin/wis2hauler

USER wis2:wis2

# Documentation only (EXPOSE publishes nothing by itself) -- the real
# port is whatever configuration.yml's global.http-port sets; keep this
# in sync with that value's default (main.ts's DEFAULT_HTTP_PORT) if
# you're relying on Docker's own -P/EXPOSE introspection rather than an
# explicit compose `ports:`/`expose:` entry.
EXPOSE 8080

# ENTRYPOINT is the fixed binary; CMD is just its default argument
# (this app's positional <config.yaml> arg -- see main.ts's parseCli),
# so a compose service can override just the `command:` (e.g. a
# different mount path) without needing to touch ENTRYPOINT at all.
#
# Debug logging has no file and no CLI flag at all -- it's turned
# on/off entirely at runtime through this same admin API (POST /set
# {"debug":["SUBSCRIBER",...]}, GET /get?key=debug -- see
# ../admin/get.ts, ../admin/set.ts), so there's nothing else to mount
# or pass here for it.
ENTRYPOINT ["/usr/local/bin/wis2hauler"]
CMD ["/configuration.yml"]
