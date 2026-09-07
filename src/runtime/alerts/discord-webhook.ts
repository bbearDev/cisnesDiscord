// 출처: chzzkbot src/runtime/alerts/discord-webhook.ts (그대로 — 계획 §14)
import type { Clock } from '../clock.js';

/**
 * 디스코드 웹훅 발송 (AC-19 / 계획 Principle 2).
 *
 * 규칙 두 가지가 전부다:
 *   ① **fire-and-forget** — 호출자는 결과를 기다리지 않는다
 *   ② **3초 타임아웃** — 디스코드가 느려도 봇이 멈추지 않는다
 *
 * 왜 이렇게까지 하나: 경보는 **부가 기능**이다. 웹훅이 죽었다고 인증 흐름이
 * 막히면 본말이 전도된다 (Principle 2 — "알림은 본체를 죽이지 않는다").
 * 그래서 이 모듈은 **어떤 경우에도 throw 하지 않는다.**
 *
 * ★ 운영 경보 전용 경로다. 사용자에게 보이는 방송·업로드 공지는 discord.js
 *   게이트웨이를 탄다(§S3 announcer). 둘을 나눈 이유: 게이트웨이가 죽었을 때
 *   그 사실을 알리는 경로가 같은 게이트웨이면 아무도 그 장애를 모른다.
 */

export const WEBHOOK_TIMEOUT_MS = 3_000;

/** 디스코드 메시지 상한은 2000자다. 넘기면 400 이 나므로 여유를 두고 자른다. */
export const WEBHOOK_MAX_CONTENT = 1900;

export interface WebhookOptions {
  /** 없거나 빈 문자열이면 발송을 조용히 건너뛴다 (미설정은 오류가 아니다) */
  url?: string | undefined;
  clock?: Clock;
  /** 테스트 주입점 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 실패를 기록만 한다. 던지지 않는다 */
  onError?: (reason: string) => void;
}

export type WebhookSendResult = 'sent' | 'skipped-no-url' | 'failed';

export interface Notifier {
  /** 절대 reject 하지 않는다 */
  send(message: string): Promise<WebhookSendResult>;
}

export function createDiscordNotifier(opts: WebhookOptions = {}): Notifier {
  const url = opts.url?.trim();
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  return {
    async send(message: string): Promise<WebhookSendResult> {
      if (!url) return 'skipped-no-url';

      const ac = new AbortController();
      const timer = setTimeout(() => {
        ac.abort();
      }, timeoutMs);

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: message.slice(0, WEBHOOK_MAX_CONTENT) }),
          signal: ac.signal,
        });
        if (!res.ok) {
          opts.onError?.(`웹훅 응답 ${String(res.status)}`);
          return 'failed';
        }
        return 'sent';
      } catch (e: unknown) {
        // 타임아웃(AbortError)·네트워크 오류·URL 오류가 전부 여기로 온다.
        opts.onError?.(e instanceof Error ? e.message : String(e));
        return 'failed';
      } finally {
        // ★ clearTimeout 을 빠뜨리면 3초짜리 타이머가 이벤트 루프를 붙잡아
        //   종료가 매 경보마다 최대 3초씩 늦어진다. chzzkbot 이 shutdown.ts 와
        //   여기, 두 곳에서 같은 함정을 기록해 뒀다.
        clearTimeout(timer);
      }
    },
  };
}
