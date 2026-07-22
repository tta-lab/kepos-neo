export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(event: "abort", listener: () => void): void;
  removeEventListener(event: "abort", listener: () => void): void;
}

class MutableCancellationSignal implements CancellationSignal {
  aborted = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(_event: "abort", listener: () => void): void {
    if (this.aborted) {
      listener();
      return;
    }
    this.listeners.add(listener);
  }

  removeEventListener(_event: "abort", listener: () => void): void {
    this.listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
}

export class CancellationController {
  readonly signal = new MutableCancellationSignal();

  abort(): void {
    this.signal.abort();
  }
}
