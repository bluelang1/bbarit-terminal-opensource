/**
 * 스케줄링 에이전트 패널 — 자연어로 터미널 명령을 예약한다.
 * "매일 9시에 npm run build", "10분마다 git pull", "30분 뒤에 ./deploy.sh"
 */

import { useState } from 'react';
import type { ScheduledJob } from './scheduler';
import { parseNaturalSchedule, describeSchedule, createJob } from './scheduler';

interface SchedulerPanelProps {
  jobs: ScheduledJob[];
  onAdd: (job: ScheduledJob) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
  onRunNow: (id: string) => void;
  onClose: () => void;
}

export function SchedulerPanel({ jobs, onAdd, onDelete, onToggle, onRunNow, onClose }: SchedulerPanelProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');

  const tryParse = (text: string) => {
    const parsed = parseNaturalSchedule(text);
    if (!parsed || !parsed.command) { setPreview(''); return null; }
    setPreview(`${describeSchedule(parsed.schedule)} → ${parsed.command}`);
    return parsed;
  };

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    const parsed = parseNaturalSchedule(text);
    if (!parsed) { setError('시간 표현을 찾지 못했어요. 예: "매일 9시에 npm run build", "10분마다 git pull"'); return; }
    if (!parsed.command) { setError('실행할 명령이 비어 있어요. 예: "매일 9시에 npm run build"'); return; }
    onAdd(createJob(parsed.command, parsed.schedule, text));
    setInput(''); setError(''); setPreview('');
  };

  const fmtNext = (ms: number) => {
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sameDay ? `오늘 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="scheduler-panel" onClick={(e) => e.stopPropagation()}>
        <div className="scheduler-header">
          <span className="scheduler-title">⏰ 스케줄링 에이전트</span>
          <button className="scheduler-close" onClick={onClose} title="닫기">✕</button>
        </div>
        <div className="scheduler-add">
          <input
            autoFocus
            value={input}
            placeholder='말로 입력: "매일 9시에 npm run build" · "10분마다 git pull" · "30분 뒤에 ./deploy.sh"'
            onChange={(e) => { setInput(e.target.value); setError(''); tryParse(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          <button onClick={submit}>예약</button>
        </div>
        {preview && <div className="scheduler-preview">→ {preview}</div>}
        {error && <div className="scheduler-error">{error}</div>}
        <div className="scheduler-list">
          {jobs.length === 0 && (
            <div className="scheduler-empty">
              예약된 작업이 없어요. 위에 자연어로 입력해보세요 — 매일/매주/N분마다/N분 뒤/내일 HH:MM 을 알아들어요.
            </div>
          )}
          {jobs.map((job) => (
            <div key={job.id} className={`scheduler-item${job.enabled ? '' : ' disabled'}`}>
              <div className="scheduler-item-main">
                <div className="scheduler-item-cmd" title={job.command}>{job.command}</div>
                <div className="scheduler-item-meta">
                  {describeSchedule(job.schedule)}
                  {job.enabled && <> · 다음 {fmtNext(job.nextRun)}</>}
                  {job.lastRun && <> · 마지막 {fmtNext(new Date(job.lastRun).getTime())}</>}
                </div>
              </div>
              <div className="scheduler-item-actions">
                <button title="지금 실행" onClick={() => onRunNow(job.id)}>▶</button>
                <button title={job.enabled ? '일시정지' : '재개'} onClick={() => onToggle(job.id)}>{job.enabled ? '⏸' : '⏵'}</button>
                <button title="삭제" onClick={() => onDelete(job.id)}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
