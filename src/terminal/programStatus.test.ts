import { describe, expect, it } from 'vitest';
import {
  PROGRAM_STATUS_QUERY_REPLY,
  aggregateProjectAgentState,
  applyProgramStatusReport,
  createProgramStatusStore,
  dropTransientProgramStatus,
  isProgramStatusQuery,
  isValidProgramStatusId,
  parseProgramStatus,
  programStatusQueryReply,
  rollupAgentState,
  rollupRecord,
  type ProgramStatusReport,
} from './programStatus';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const report = (data: string) => parseProgramStatus(data) as ProgramStatusReport;
const apply = (store: ReturnType<typeof createProgramStatusStore>, data: string) => {
  const r = parseProgramStatus(data);
  if (!r || 'query' in r) throw new Error(`not a report: ${data}`);
  applyProgramStatusReport(store, r);
};

describe('query detection', () => {
  it('should_recognize_bare_query', () => {
    expect(parseProgramStatus('?')).toEqual({ query: true });
    expect(isProgramStatusQuery(' ? ')).toBe(true);
  });

  it('should_recognize_query_with_trailing_options', () => {
    expect(parseProgramStatus('?:v=1')).toEqual({ query: true });
  });

  it('should_not_treat_reports_as_query', () => {
    expect(isProgramStatusQuery('state=working')).toBe(false);
    expect(isProgramStatusQuery('?x')).toBe(false);
  });

  it('should_build_reply_with_requested_terminator', () => {
    expect(PROGRAM_STATUS_QUERY_REPLY).toBe('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth');
    expect(programStatusQueryReply()).toBe(`${PROGRAM_STATUS_QUERY_REPLY}\x1b\\`);
    expect(programStatusQueryReply('\x07')).toBe(`${PROGRAM_STATUS_QUERY_REPLY}\x07`);
  });
});

describe('parseProgramStatus', () => {
  it('should_parse_state_and_app', () => {
    expect(parseProgramStatus('state=working:app=claude-code')).toEqual({ state: 'working', app: 'claude-code' });
  });

  it('should_trim_keys_and_values', () => {
    expect(parseProgramStatus(' state = blocked : kind = permission ')).toEqual({ state: 'blocked', kind: 'permission' });
  });

  it('should_skip_malformed_pairs_and_unknown_keys', () => {
    expect(parseProgramStatus('garbage:=x:state=done:foo=bar')).toEqual({ state: 'done' });
  });

  it('should_use_last_value_for_duplicate_keys', () => {
    expect(report('state=working:state=done').state).toBe('done');
  });

  it('should_ignore_report_without_or_with_unknown_state', () => {
    expect(parseProgramStatus('app=claude-code')).toBeNull();
    expect(parseProgramStatus('state=sleeping')).toBeNull();
    expect(parseProgramStatus('state=')).toBeNull();
    expect(parseProgramStatus('')).toBeNull();
  });

  it('should_keep_kind_only_for_blocked', () => {
    expect(report('state=blocked:kind=question').kind).toBe('question');
    expect(report('state=working:kind=question').kind).toBeUndefined();
    expect(report('state=blocked:kind=nope').kind).toBeUndefined();
  });

  it('should_accept_progress_0_to_100_for_working_and_blocked', () => {
    expect(report('state=working:progress=42').progress).toBe(42);
    expect(report('state=blocked:progress=100').progress).toBe(100);
    expect(report('state=working:progress=101').progress).toBeUndefined();
    expect(report('state=working:progress=4.5').progress).toBeUndefined();
    expect(report('state=working:progress=-1').progress).toBeUndefined();
    expect(report('state=done:progress=50').progress).toBeUndefined();
  });

  it('should_decode_base64_utf8_title_and_msg', () => {
    const r = report(`state=blocked:kind=permission:title=${b64('빠릿')}:msg=${b64('Bash 실행 허용?')}`);
    expect(r.title).toBe('빠릿');
    expect(r.msg).toBe('Bash 실행 허용?');
  });

  it('should_drop_msg_with_control_chars_or_bad_base64', () => {
    expect(report(`state=done:msg=${b64('a\x1b[31mb')}`).msg).toBeUndefined();
    expect(report(`state=done:msg=${b64('line\nbreak')}`).msg).toBeUndefined();
    expect(report('state=done:msg=***').msg).toBeUndefined();
    expect(report('state=done:msg=abc').msg).toBeUndefined();
  });

  it('should_enforce_title_and_msg_byte_caps', () => {
    expect(report(`state=done:title=${b64('x'.repeat(192))}`).title).toHaveLength(192);
    expect(report(`state=done:title=${b64('x'.repeat(193))}`).title).toBeUndefined();
    expect(report(`state=done:msg=${b64('x'.repeat(2049))}`).msg).toBeUndefined();
  });

  it('should_reject_sequences_over_4096_bytes', () => {
    const pad = 'x'.repeat(4096);
    expect(parseProgramStatus(`state=working:pad=${pad}`)).toBeNull();
  });

  it('should_validate_id_and_drop_report_with_bad_id', () => {
    expect(report('state=working:id=task/sub.1').id).toBe('task/sub.1');
    expect(parseProgramStatus('state=working:id=bad id')).toBeNull();
    expect(parseProgramStatus('state=working:id=a//b')).toBeNull();
    expect(isValidProgramStatusId('a/b/c/d/e/f/g/h')).toBe(true);
    expect(isValidProgramStatusId('a/b/c/d/e/f/g/h/i')).toBe(false);
    expect(isValidProgramStatusId('x'.repeat(33))).toBe(false);
  });

  it('should_drop_invalid_app', () => {
    expect(report('state=idle:app=bad app').app).toBeUndefined();
  });
});

describe('store, rollup and turn', () => {
  it('should_follow_root_record', () => {
    const s = createProgramStatusStore();
    expect(rollupAgentState(s)).toBe('idle');
    apply(s, 'state=working');
    expect(rollupAgentState(s)).toBe('working');
    apply(s, 'state=blocked:kind=permission');
    expect(rollupAgentState(s)).toBe('blocked');
    expect(rollupRecord(s)?.kind).toBe('permission');
    expect(s.reported).toBe(true);
  });

  it('should_use_children_only_without_root_with_priority', () => {
    const s = createProgramStatusStore();
    apply(s, 'state=done:id=a');
    apply(s, 'state=working:id=b');
    expect(rollupAgentState(s)).toBe('working');
    apply(s, 'state=blocked:id=c');
    expect(rollupAgentState(s)).toBe('blocked');
    apply(s, 'state=idle');
    expect(rollupAgentState(s)).toBe('idle'); // 루트가 생기면 루트를 따른다
  });

  it('should_map_error_to_done', () => {
    const s = createProgramStatusStore();
    apply(s, 'state=error');
    expect(rollupAgentState(s)).toBe('done');
  });

  it('should_clear_id_with_children_or_everything', () => {
    const s = createProgramStatusStore();
    apply(s, 'state=working:id=a');
    apply(s, 'state=working:id=a/b');
    apply(s, 'state=working:id=ab');
    apply(s, 'state=clear:id=a');
    expect([...s.children.keys()]).toEqual(['ab']);
    apply(s, 'state=working');
    apply(s, 'state=clear');
    expect(s.root).toBeNull();
    expect(s.children.size).toBe(0);
  });

  it('should_cap_records_at_256', () => {
    const s = createProgramStatusStore();
    for (let i = 0; i < 300; i++) apply(s, `state=working:id=t${i}`);
    expect(s.children.size).toBe(256);
    apply(s, 'state=done:id=t0'); // 기존 id 갱신은 허용
    expect(s.children.get('t0')?.state).toBe('done');
  });

  it('should_increment_turn_when_leaving_working', () => {
    const s = createProgramStatusStore();
    apply(s, 'state=working');
    expect(s.turn).toBe(0);
    apply(s, 'state=working');
    expect(s.turn).toBe(0);
    apply(s, 'state=blocked');
    expect(s.turn).toBe(1);
    apply(s, 'state=blocked');
    expect(s.turn).toBe(1);
    apply(s, 'state=working');
    apply(s, 'state=done');
    expect(s.turn).toBe(2);
    apply(s, 'state=idle');
    expect(s.turn).toBe(2);
  });

  it('should_drop_working_and_blocked_on_exit_but_keep_done', () => {
    const s = createProgramStatusStore();
    apply(s, 'state=working');
    apply(s, 'state=done:id=x');
    apply(s, 'state=blocked:id=y');
    dropTransientProgramStatus(s);
    expect(s.root).toBeNull();
    expect([...s.children.keys()]).toEqual(['x']);
    expect(rollupAgentState(s)).toBe('done');
    expect(s.turn).toBe(1);
  });
});

describe('aggregateProjectAgentState', () => {
  it('should_prefer_blocked_then_done_then_working', () => {
    expect(aggregateProjectAgentState([])).toBe('idle');
    expect(aggregateProjectAgentState(['idle', 'working'])).toBe('working');
    expect(aggregateProjectAgentState(['working', 'done'])).toBe('done');
    expect(aggregateProjectAgentState(['done', 'blocked', 'working'])).toBe('blocked');
  });
});
