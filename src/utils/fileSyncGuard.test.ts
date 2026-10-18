import { describe, expect, it } from 'vitest';
import { contentFingerprint, diskChangedSinceLoad } from './fileSyncGuard';

describe('contentFingerprint', () => {
  it('should_be_stable_for_identical_content', () => {
    const text = '# Doc\n\n**bold** | 한국어 | emoji 🐙\n';
    expect(contentFingerprint(text)).toBe(contentFingerprint(text));
  });

  it('should_differ_for_changed_content', () => {
    const base = '# Doc\n\n**keep**\n';
    expect(contentFingerprint(base)).not.toBe(contentFingerprint(base + ' '));
    expect(contentFingerprint(base)).not.toBe(contentFingerprint(base.replace('keep', 'kept')));
    expect(contentFingerprint('')).not.toBe(contentFingerprint('\n'));
  });

  it('should_handle_empty_and_unicode_content', () => {
    expect(contentFingerprint('')).toBeGreaterThanOrEqual(0);
    expect(contentFingerprint('한국어 문서 🐙')).toBe(contentFingerprint('한국어 문서 🐙'));
  });
});

describe('diskChangedSinceLoad', () => {
  it('should_report_conflict_only_when_disk_diverges', () => {
    const loaded = 'original';
    const fingerprint = contentFingerprint(loaded);
    expect(diskChangedSinceLoad(loaded, fingerprint)).toBe(false);
    expect(diskChangedSinceLoad('agent edited this', fingerprint)).toBe(true);
  });

  it('should_never_conflict_without_a_baseline', () => {
    // Legacy tabs (no fingerprint yet) keep the old always-write behavior.
    expect(diskChangedSinceLoad('anything', undefined)).toBe(false);
  });
});
