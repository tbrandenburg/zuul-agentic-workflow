FROM alpine:3.20
RUN apk add --no-cache git git-daemon
RUN git config --system --add safe.directory '*'
EXPOSE 9418
ENTRYPOINT ["git", "daemon", "--base-path=/repos", "--export-all", \
            "--enable=receive-pack", "--reuseaddr", "--verbose", \
            "--listen=0.0.0.0"]
