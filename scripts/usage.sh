#!/bin/sh
# Feature usage (MR-83) from the terminal: ./scripts/usage.sh [days]   (default 30, 0 = all time)
# Reads the app's own usage table and ui.* events; MR_DATA_DIR picks another data folder.
DAYS="${1:-30}"
DB="${MR_DATA_DIR:-$HOME/Library/Application Support/dev.minorityreport.app}/events.sqlite"
[ -f "$DB" ] || { echo "No event log at $DB" >&2; exit 1; }
SINCE=$(( ($(date +%s) - DAYS * 86400) * 1000 )); [ "$DAYS" = 0 ] && SINCE=0
sqlite3 -column -header "$DB" "
SELECT kind, name, detail, SUM(at >= $SINCE) AS used, COUNT(*) AS ever, date(MAX(at)/1000, 'unixepoch', 'localtime') AS last
FROM usage GROUP BY kind, name, detail
UNION ALL
SELECT 'action', substr(kind, 4), '', SUM(created_at >= $SINCE), COUNT(*), date(MAX(created_at)/1000, 'unixepoch', 'localtime')
FROM events WHERE kind LIKE 'ui.%' GROUP BY kind
ORDER BY used DESC, ever DESC;"
