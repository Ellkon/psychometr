# Backup tools (S-10): the same PostgreSQL major as the db service, plus age (BSD-3-Clause).
FROM postgres:16-alpine
RUN apk add --no-cache age
COPY compass-backup.sh /usr/local/bin/compass-backup
RUN chmod 0755 /usr/local/bin/compass-backup
ENTRYPOINT ["/usr/local/bin/compass-backup"]
