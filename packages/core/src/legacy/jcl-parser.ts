export interface JclJob {
  jobName: string;
  steps: JclStep[];
  symbols: Map<string, string>;
}

export interface JclStep {
  name: string;
  pgm?: string;
  proc?: string;
  dd: JclDd[];
}

export interface JclDd {
  name: string;
  dsname?: string;
  disp?: string;
}

export function parse(content: string): JclJob {
  const lines = content.split('\n');
  const job: JclJob = { jobName: '', steps: [], symbols: new Map() };
  let currentStep: JclStep | null = null;

  for (const line of lines) {
    if (!line.startsWith('//') || line.startsWith('//*')) continue;

    const jobMatch = line.match(/^\/\/(\S+)\s+JOB\s+/);
    if (jobMatch) {
      job.jobName = jobMatch[1];
      continue;
    }

    const setMatch = line.match(/^\/\/\s+SET\s+(\w+)=(.+)/);
    if (setMatch) {
      job.symbols.set(setMatch[1], setMatch[2].trim());
      continue;
    }

    const execMatch = line.match(/^\/\/(\S+)\s+EXEC\s+(?:PGM=(\S+)|PROC=(\S+))/);
    if (execMatch) {
      currentStep = { name: execMatch[1], dd: [] };
      if (execMatch[2]) currentStep.pgm = execMatch[2].replace(/,.*$/, '');
      else if (execMatch[3]) currentStep.proc = execMatch[3].replace(/,.*$/, '');
      job.steps.push(currentStep);
      continue;
    }

    const ddMatch = line.match(/^\/\/(\S+)\s+DD\s+(.*)/);
    if (ddMatch && currentStep) {
      const dd: JclDd = { name: ddMatch[1] };
      const dsnMatch = ddMatch[2].match(/DSN=([^,\s]+)/);
      if (dsnMatch) dd.dsname = dsnMatch[1];
      const dispMatch = ddMatch[2].match(/DISP=\(?([^,)\s]+)/);
      if (dispMatch) dd.disp = dispMatch[1];
      currentStep.dd.push(dd);
    }
  }

  return job;
}
