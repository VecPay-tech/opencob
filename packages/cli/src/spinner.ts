const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private label = '';

  start(label: string): void {
    this.label = label;
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  update(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write('\r\x1b[K');
  }

  private tick(): void {
    const icon = FRAMES[this.frame % FRAMES.length];
    this.frame++;
    process.stdout.write(`\r\x1b[K\x1b[2m${icon} ${this.label}\x1b[0m`);
  }
}
