import { describe, expect, it } from 'vitest';
import { blockedAlertText, decideAgentAlert, isUserLooking } from './agentAlert';

describe('decideAgentAlert', () => {
  it('should_alert_blocked_whether_looking_or_not', () => {
    expect(decideAgentAlert('working', 'blocked', true, false)).toBe('blocked');
    expect(decideAgentAlert('working', 'blocked', false, false)).toBe('blocked');
    expect(decideAgentAlert('idle', 'blocked', true, false)).toBe('blocked');
  });

  it('should_alert_done_only_when_not_looking', () => {
    expect(decideAgentAlert('working', 'done', true, false)).toBeNull();
    expect(decideAgentAlert('working', 'done', false, false)).toBe('done');
    expect(decideAgentAlert('blocked', 'idle', false, false)).toBe('done');
    expect(decideAgentAlert('working', 'idle', true, false)).toBeNull();
  });

  it('should_ignore_repeat_reports_in_same_turn', () => {
    expect(decideAgentAlert('blocked', 'blocked', false, false)).toBeNull();
    expect(decideAgentAlert('done', 'done', false, false)).toBeNull();
    expect(decideAgentAlert('working', 'working', false, false)).toBeNull();
    expect(decideAgentAlert('done', 'idle', false, false)).toBeNull();
  });

  it('should_never_alert_on_first_report_after_startup', () => {
    expect(decideAgentAlert(null, 'blocked', false, true)).toBeNull();
    expect(decideAgentAlert('working', 'done', false, true)).toBeNull();
  });

  it('should_not_alert_when_work_starts', () => {
    expect(decideAgentAlert('idle', 'working', false, false)).toBeNull();
    expect(decideAgentAlert('blocked', 'working', false, false)).toBeNull();
  });
});

describe('isUserLooking', () => {
  const doc = (focus: boolean, hidden: boolean) => ({ hasFocus: () => focus, hidden });
  it('should_require_active_tab_focus_and_visibility', () => {
    expect(isUserLooking(true, doc(true, false))).toBe(true);
    expect(isUserLooking(false, doc(true, false))).toBe(false);
    expect(isUserLooking(true, doc(false, false))).toBe(false);
    expect(isUserLooking(true, doc(true, true))).toBe(false);
  });
});

describe('blockedAlertText', () => {
  it('should_format_title_and_body_by_kind', () => {
    expect(blockedAlertText('web', 'Claude', 'permission', 'Bash 실행')).toEqual({
      title: 'web · Claude 이(가) 기다립니다',
      body: '권한 승인 필요 · Bash 실행',
    });
    expect(blockedAlertText('web', '', 'question').body).toBe('질문에 답해 주세요');
    expect(blockedAlertText('', '', 'auth').body).toBe('로그인 필요');
  });
});
