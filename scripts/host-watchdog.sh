#!/usr/bin/env bash
#
# 호스트 워치독 — 봇 프로세스 **밖**의 dead-man's-switch (계획 §S8, AC-34).
#
# 출처: chzzkbot scripts/host-watchdog.sh 를 옮겨 심었다.
#
# 왜 봇 밖인가: "봇이 내려가 있으면 봇 안의 잡도 내려가 있다."
# 프로세스가 통째로 죽거나 systemd 가 재시작을 포기하면 봇 안의 어떤 감시도 함께 죽는다.
# 그걸 알아챌 수 있는 것은 바깥에 있는 감시자뿐이다.
#
# 주기와 임계: 시간당 실행 + 90분 임계 → 탐지 지연 최대 약 2.5시간.
#
# 설치: docs/runbook-ops.md 참조. 이 파일만 있고 타이머가 enable 되지 않으면
#       "호스트는 살아 있으나 워치독이 설치되지 않음" 이 기본 상태가 된다.

set -uo pipefail

ENV_FILE="${WATCHDOG_ENV_FILE:-$HOME/.config/cisnesdiscord/watchdog.env}"
HEARTBEAT="${HEARTBEAT_PATH:-}"
THRESHOLD_MIN="${THRESHOLD_MIN:-90}"

# 웹훅 URL 은 0600 파일에서 읽는다 — 타이머 환경에 평문으로 두지 않는다.
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

: "${DISCORD_WEBHOOK_URL:=}"
HEARTBEAT="${HEARTBEAT:-${HEARTBEAT_PATH:-}}"

# ★ 기본 경로를 두지 않는다. 개발 기계의 절대경로를 기본값으로 박아두면
#   그 경로는 운영 서버에 없고, 워치독이 "하트비트 파일이 없다"고 매시간
#   오경보를 내 **진짜 고장과 구별되지 않는다.**
if [ -z "$HEARTBEAT" ]; then
  echo "[cisnesdiscord-watchdog] HEARTBEAT_PATH 가 설정되지 않았습니다 ($ENV_FILE 확인)" >&2
  exit 2
fi

HOWTO="systemctl --user status ${SYSTEMD_UNIT:-cisnesdiscord.service}"

# JSON 문자열 이스케이프. 큰따옴표와 역슬래시만 처리하면 충분하다 —
# 메시지는 이 스크립트가 만들고 제어문자를 넣지 않는다.
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

notify() {
  local msg="$1"
  if [ -z "$DISCORD_WEBHOOK_URL" ]; then
    # 알릴 곳이 없으면 stderr 로 남긴다. journal 에 남는다.
    echo "[cisnesdiscord-watchdog] $msg (DISCORD_WEBHOOK_URL 미설정)" >&2
    return
  fi
  if ! curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"content\":\"$(json_escape "$msg")\"}" \
    "$DISCORD_WEBHOOK_URL" >/dev/null 2>&1; then
    echo "[cisnesdiscord-watchdog] 웹훅 발송 실패" >&2
  fi
}

# ★ 하트비트보다 **먼저** 유닛 상태를 본다.
#   재시작 한계(StartLimitBurst)를 넘겨 systemd 가 포기하면 프로세스는 아예 없고
#   하트비트는 그냥 낡아만 간다. 두 증상이 같아 보이지만 조치가 다르다:
#   전자는 `reset-failed` 가 필요하고 후자는 재시작이면 된다.
if [ -n "${SYSTEMD_UNIT:-}" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-failed --quiet "$SYSTEMD_UNIT"; then
    notify "🔴 cisnesDiscord 서비스가 failed 상태입니다 (재시작 한계 초과). 확인: \`$HOWTO\` · 복구: \`systemctl --user reset-failed $SYSTEMD_UNIT && systemctl --user start $SYSTEMD_UNIT\`"
    exit 1
  fi
  if ! systemctl --user is-active --quiet "$SYSTEMD_UNIT"; then
    # ★ exit 78 로 죽었다면 재시작해도 낫지 않는다 — 설정 문제이거나 포트를
    #   남이 잡고 있는 것이다 (§5.4). 안내에 진단 명령을 함께 싣는다.
    notify "🔴 cisnesDiscord 서비스가 돌고 있지 않습니다 (inactive). 확인: \`$HOWTO\` · exit 78 이면 포트 점유를 의심하고 \`ss -ltnp | grep :8081\` 를 봅니다"
    exit 1
  fi
fi

if [ ! -e "$HEARTBEAT" ]; then
  notify "🔴 cisnesDiscord 하트비트 파일이 없습니다: $HEARTBEAT — 봇이 한 번도 기동하지 않았거나 data 디렉터리가 사라졌습니다."
  exit 1
fi

now=$(date +%s)
mtime=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT")
age_min=$(( (now - mtime) / 60 ))

if [ "$age_min" -ge "$THRESHOLD_MIN" ]; then
  notify "🔴 cisnesDiscord 가 ${age_min}분째 하트비트를 갱신하지 않았습니다 (임계 ${THRESHOLD_MIN}분). 프로세스는 살아 있으나 일을 하지 않는 상태입니다. 확인: \`$HOWTO\`"
  exit 1
fi

exit 0
