// 출처: chzzkbot src/runtime/shutdown.ts (그대로 — 계획 §14)
/**
 * 종료 처리.
 *
 * SIGTERM/SIGINT 에서 락을 풀고 DB 를 닫는다. 락을 안 풀면 다음 기동이
 * "다른 인스턴스가 실행 중" 으로 거부당한다 — PID 생존 확인이 그걸 구제하지만,
 * 정상 종료에서까지 그 경로에 기대지 않는다.
 *
 * 순서가 중요하다. 원장에 claim 을 쓰는 중이라면 그게 끝나야 DB 를 닫을 수 있다.
 * 그래서 등록 순서의 역순으로 정리한다 — 나중에 연 것을 먼저 닫는다.
 */

export type ShutdownTask = () => void | Promise<void>;

export interface ShutdownOptions {
  /** 정리가 이만큼 걸리면 포기하고 종료한다. systemd 의 TimeoutStopSec 보다 짧게. */
  timeoutMs?: number;
  /** 종료 사유를 로그로 남길 수 있게. 로거를 여기서 직접 부르지 않고 주입받는다. */
  onBegin?: (reason: string) => void;
  onError?: (label: string, err: unknown) => void;
  exit?: (code: number) => void;
}

export class ShutdownManager {
  private readonly tasks: { label: string; run: ShutdownTask }[] = [];
  private running = false;

  constructor(private readonly opts: ShutdownOptions = {}) {}

  /** 정리 작업을 등록한다. 실행은 등록의 역순. */
  register(label: string, run: ShutdownTask): void {
    this.tasks.push({ label, run });
  }

  /** SIGTERM/SIGINT 를 잡는다. 반환값으로 해제할 수 있다 (테스트용). */
  install(): () => void {
    const handler = (signal: NodeJS.Signals): void => {
      void this.shutdown(signal);
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
    return () => {
      process.off('SIGTERM', handler);
      process.off('SIGINT', handler);
    };
  }

  async shutdown(reason: string, code = 0): Promise<void> {
    if (this.running) return; // 시그널이 두 번 와도 한 번만 돈다
    this.running = true;
    this.opts.onBegin?.(reason);

    const timeoutMs = this.opts.timeoutMs ?? 8_000;
    const work = (async () => {
      for (const t of [...this.tasks].reverse()) {
        try {
          await t.run();
        } catch (e: unknown) {
          // 하나가 실패해도 나머지 정리는 계속한다.
          this.opts.onError?.(t.label, e);
        }
      }
    })();

    // 타임아웃 타이머를 반드시 걷어낸다. 안 걷으면 정리가 먼저 끝나도
    // 이벤트 루프가 timeoutMs 만큼 더 살아 있어 종료가 늦어진다.
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    try {
      await Promise.race([work, guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    (this.opts.exit ?? ((c: number) => process.exit(c)))(code);
  }

  /** 등록된 작업 수 — 테스트용 */
  get size(): number {
    return this.tasks.length;
  }
}
