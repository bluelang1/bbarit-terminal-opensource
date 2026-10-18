import { invoke } from '@tauri-apps/api/core';

export type HarnessBackendJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface HarnessBackendJob {
  id: string;
  label: string;
  commandPreview: string;
  workDir?: string;
  status: HarnessBackendJobStatus;
  output: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export function startHarnessBackendJob(params: {
  command: string;
  workDir: string;
  timeoutSecs?: number;
  label?: string;
}): Promise<HarnessBackendJob> {
  return invoke<HarnessBackendJob>('start_harness_job', {
    command: params.command,
    workDir: params.workDir,
    timeoutSecs: params.timeoutSecs,
    label: params.label,
  });
}

export function listHarnessBackendJobs(): Promise<HarnessBackendJob[]> {
  return invoke<HarnessBackendJob[]>('list_harness_jobs');
}

export function getHarnessBackendJob(jobId: string): Promise<HarnessBackendJob | null> {
  return invoke<HarnessBackendJob | null>('get_harness_job', { jobId });
}

export function cancelHarnessBackendJob(jobId: string): Promise<void> {
  return invoke<void>('cancel_harness_job', { jobId });
}

export async function waitForHarnessBackendJob(jobId: string, pollMs = 800): Promise<HarnessBackendJob> {
  for (;;) {
    const job = await getHarnessBackendJob(jobId);
    if (!job) throw new Error('Harness job disappeared.');
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error || 'Harness job failed.');
    if (job.status === 'cancelled') throw new Error(job.error || 'Harness job was cancelled.');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
