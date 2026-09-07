/**
 * 비밀값 마스킹 — 단일 지점 (AC-32).
 * 출처: chzzkbot src/runtime/redact.ts — 값 모양 그물에 이 저장소의 비밀값 3종을 더했다.
 *
 * 로그와 실측 픽스처 두 곳에서 같은 규칙을 써야 한다. 규칙이 갈라지면 한쪽만
 * 고쳤을 때 다른 쪽으로 비밀값이 새고, 그게 보안 통제에서 가장 흔한 실패다.
 * 그래서 이 모듈이 유일한 정의다.
 *
 * 두 그물을 겹쳐 건다:
 *   ① 키 이름   — secret / token / authorization / webhook / password / cookie / credential
 *   ② 값의 모양 — Bearer …, 40자 이상 토큰류, 디스코드 웹훅 URL, **디스코드 봇 토큰**
 *
 * ②가 필요한 이유: 응답 스키마가 바뀌어 이름이 무해한 새 필드로 토큰이 실려 오면
 * ①만으로는 그대로 새어 나간다.
 *
 * ★ 이 저장소에서 반드시 잡아야 하는 것 3종 (계획 §S2 ★ 항목):
 *   - **디스코드 봇 토큰** — `<base64 id>.<base64 ts>.<hmac>` 모양. 점이 있어
 *     chzzkbot 의 `^[A-Za-z0-9_-]{40,}$` 에 **걸리지 않는다.** 전용 패턴이 필요하다.
 *   - **디스코드 웹훅 URL** — 그 자체가 발송 권한이다.
 *   - **`LIVE_API_TOKEN` 모양의 48자 hex** — 계약 §2 가 경고한 대로 이 토큰 하나가
 *     **chzzkbot 에 등록된 모든 채널을 연다.** 봇 토큰과 같은 등급으로 다룬다.
 *
 * ★ 32자 hex 는 일부러 그물에 넣지 않는다. 치지직 channelId 가 정확히 32자 hex 라
 *   (`c3355ea2…`) 넣으면 공개 식별자가 전부 가려져 로그가 쓸모없어진다.
 *   토큰은 48자라 40자 하한이 둘을 가른다.
 */

export const SECRET_KEY_PATTERN =
  /(secret|token|authorization|password|webhook|cookie|credential)/i;

/** 디스코드 봇 토큰 — `MTIz….Gx1y2z.hmac…` */
const DISCORD_BOT_TOKEN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^Bearer\s+\S+/i,
  /^[A-Za-z0-9_-]{40,}$/,
  /https:\/\/discord(app)?\.com\/api\/webhooks\/\S+/i,
  DISCORD_BOT_TOKEN,
];

/** 원문 길이는 남기되 값은 복원되지 않는 형태로. 디버깅에 길이가 자주 필요하다. */
export function maskString(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-2)}[len=${String(value.length)}]`;
}

export function looksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

/** 문자열 하나를 판정해 필요하면 가린다. keyHint 가 있으면 키 이름 그물도 함께 건다. */
export function redactString(value: string, keyHint = ''): string {
  if (SECRET_KEY_PATTERN.test(keyHint) || looksSecret(value)) {
    return maskString(value);
  }
  // 문장 한가운데 박힌 것들도 잡는다 (로그 메시지 본문 대비).
  // 순서가 중요하다: 웹훅 URL 을 먼저 지워야 URL 끝의 토큰 조각이
  // 봇 토큰 패턴에 절반만 걸려 원문 일부가 남는 일이 없다.
  return value
    .replace(/https:\/\/discord(app)?\.com\/api\/webhooks\/\S+/gi, (m) => maskString(m))
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, (m) => maskString(m))
    .replace(new RegExp(DISCORD_BOT_TOKEN.source, 'g'), (m) => maskString(m))
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => maskString(m));
}

/** 객체·배열을 재귀로 훑어 마스킹한다. */
export function redactDeep(input: unknown, keyHint = ''): unknown {
  if (typeof input === 'string') return redactString(input, keyHint);
  if (Array.isArray(input)) return input.map((v) => redactDeep(v, keyHint));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = redactDeep(v, k);
    return out;
  }
  return input;
}
