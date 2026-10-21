#!/bin/sh
# OpenWrt has no Python: verify its ELF container and x86_64 CPU before execution.
set -eu
fail() { echo 'EXECUTABLE_IDENTITY_REJECTED: expected complete ELF64 x86_64 executable' >&2; exit 1; }
binary=${1:?Executable required}
[ -f "$binary" ] || fail
size=$(wc -c < "$binary" | tr -d ' ')
[ "$size" -ge 64 ] || fail
identity=$(od -An -tx1 -N20 "$binary" | tr -d ' \n')
case "$identity" in 7f454c46020101*) ;; *) fail ;; esac
[ "${#identity}" = 40 ] || fail
kind=$(od -An -tu2 -j16 -N2 "$binary" | tr -d ' ')
machine=$(od -An -tu2 -j18 -N2 "$binary" | tr -d ' ')
[ "$machine" = 62 ] && { [ "$kind" = 2 ] || [ "$kind" = 3 ]; } || fail
entry=$(od -An -tu8 -j24 -N8 "$binary" | tr -d ' ')
table=$(od -An -tu8 -j32 -N8 "$binary" | tr -d ' ')
header=$(od -An -tu2 -j52 -N2 "$binary" | tr -d ' ')
rows=$(od -An -tu2 -j56 -N2 "$binary" | tr -d ' ')
width=$(od -An -tu2 -j54 -N2 "$binary" | tr -d ' ')
[ "$header" = 64 ] && [ "$width" = 56 ] && [ "$rows" -ge 1 ] && [ "$rows" -le 4096 ] || fail
awk -v table="$table" -v rows="$rows" -v size="$size" 'BEGIN { exit !(table >= 64 && table <= size && table + rows * 56 <= size) }' || fail
od -An -v -tu8 -j "$table" -N "$((rows * 56))" "$binary" | awk -v size="$size" -v entry="$entry" '
{ for (i=1;i<=NF;i++) { fields[++count]=$i; if (count==7) {
    if (fields[2] > size || fields[5] > size || fields[2]+fields[5] > size) bad=1;
    type=fields[1]%4294967296; flags=int(fields[1]/4294967296);
    if (type==1 && flags%2==1 && fields[6]>=fields[5] && entry>=fields[3] && entry<fields[3]+fields[6]) executable=1;
    count=0;
} } }
END { exit (bad || count || !executable) }' || fail
