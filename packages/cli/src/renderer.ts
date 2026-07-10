import type { AgentEvent } from '@opencob/core';
import { Spinner } from './spinner.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

export class CliRenderer {
  constructor(private readonly spinner: Spinner) {}

  async render(events: AsyncIterable<AgentEvent>): Promise<void> {
    this.spinner.start('Thinking…');

    for await (const event of events) {
      switch (event.type) {
        case 'text':
          this.spinner.stop();
          process.stdout.write(event.text ?? '');
          break;

        case 'thinking':
          // Extended thinking: optionally surface partial thoughts in dim colour
          if (event.thinking) {
            this.spinner.stop();
            process.stdout.write(`${DIM}  ${event.thinking}${RESET}\n`);
          }
          break;

        case 'thinking_end':
          // Nothing visible — resume spinner
          this.spinner.start('Thinking…');
          break;

        case 'tool_call': {
          this.spinner.stop();
          const argsSummary = JSON.stringify(event.toolCall?.parameters ?? {}).slice(0, 60);
          process.stdout.write(
            `\n${DIM}  ⚙ ${event.toolCall?.name ?? 'tool'}(${argsSummary})${RESET}\n`,
          );
          this.spinner.start(`Running ${event.toolCall?.name ?? 'tool'}…`);
          break;
        }

        case 'tool_result': {
          this.spinner.stop();
          const result = event.toolResult;
          if (result && !result.success) {
            process.stdout.write(
              `${DIM}  ${RED}✗ error: ${String(result.content).slice(0, 80)}${RESET}\n`,
            );
          } else {
            process.stdout.write(`${DIM}  ${GREEN}✓ done${RESET}\n`);
          }
          break;
        }

        case 'phase_change':
          this.spinner.update(event.phase ?? 'Working…');
          break;

        case 'mode_switch':
          this.spinner.stop();
          process.stdout.write(`  → Switched to ${event.mode ?? 'unknown'} mode\n`);
          break;

        case 'self_correction':
          this.spinner.stop();
          process.stdout.write(
            `${DIM}  ↺ Self-correcting (attempt ${event.attempt ?? 1})…${RESET}\n`,
          );
          this.spinner.start('Retrying…');
          break;

        case 'compaction':
          this.spinner.update('Compacting context…');
          break;

        case 'verification':
          this.spinner.update('Verifying changes…');
          break;

        case 'skill_activated':
          this.spinner.update(`Skill: ${event.text ?? 'active'}…`);
          break;

        case 'plan_created':
          this.spinner.stop();
          if (event.plan) {
            process.stdout.write(`\n${DIM}  Plan: ${event.plan.goal}${RESET}\n`);
          }
          break;

        case 'plan_step_update':
          if (event.planStep) {
            const { stepIndex, status, summary } = event.planStep;
            const icon = status === 'done' ? `${GREEN}✓` : status === 'failed' ? `${RED}✗` : '…';
            process.stdout.write(
              `${DIM}  Step ${stepIndex + 1} ${icon} ${summary ?? status}${RESET}\n`,
            );
          }
          break;

        case 'changes_summary':
          this.spinner.stop();
          if (event.changesSummary) {
            const { filesChanged, linesAdded, linesRemoved } = event.changesSummary;
            process.stdout.write(
              `\n${DIM}  ${filesChanged} file(s) changed, +${linesAdded} -${linesRemoved}${RESET}\n`,
            );
          }
          break;

        case 'error':
          this.spinner.stop();
          process.stderr.write(`Error: ${event.error ?? 'unknown error'}\n`);
          break;

        case 'done':
          this.spinner.stop();
          process.stdout.write('\n');
          break;
      }
    }
  }
}
